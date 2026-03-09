/**
 * scripts/migrateAds.js
 *
 * Standalone migration script that re-posts all existing ads from db.createAds
 * into their respective category-based channels using a "short version" format.
 *
 * Usage:
 *   node scripts/migrateAds.js [--force]
 *
 * Options:
 *   --force   Re-post even if a categoryMessageId already exists for an ad.
 *
 * Required environment variables (same as the main bot):
 *   BOT_TOKEN              Discord bot token
 *   GUILD_ID               Discord server (guild) ID
 *   FIND_A_TUTOR_CHANNEL_ID  Channel ID for the main find-a-tutor channel
 *
 * The script reads and writes data.json directly, mirroring the bot's db layer.
 */

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data.json');

const {
  BOT_TOKEN,
  GUILD_ID,
  FIND_A_TUTOR_CHANNEL_ID
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !FIND_A_TUTOR_CHANNEL_ID) {
  console.error('Missing required env vars: BOT_TOKEN, GUILD_ID, FIND_A_TUTOR_CHANNEL_ID');
  process.exit(1);
}

const force = process.argv.includes('--force');

const MAX_DESCRIPTION_LINES = 4;
const RATE_LIMIT_DELAY_MS = 1000;

// --- CreateAd level configuration (mirrors CREATEAD_LEVEL_CONFIG in index.js) ---
const CREATEAD_LEVEL_CONFIG = {
  igcse:       { categoryName: 'IGCSE Tutors',       prefix: 'ig-' },
  a_level:     { categoryName: 'AS/A Level Tutors',  prefix: 'asl-al-' },
  below_igcse: { categoryName: 'Below IGCSE Tutors', prefix: '' },
  university:  { categoryName: 'University Tutors',  prefix: 'uni-' },
  language:    { categoryName: 'Language Tutors',    prefix: 'lang-' },
  test_prep:   { categoryName: 'Test Prep Tutors',   prefix: 'testprep-' },
  other:       { categoryName: 'Other Tutors',       prefix: '' },
};

function loadDB() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load data.json:', e.message);
    process.exit(1);
  }
}

function saveDB(db) {
  writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

/**
 * Infers the CREATEAD_LEVEL_CONFIG key from the subject name prefix when no
 * explicit levelKey is stored (mirrors detectLevelFromSubject in index.js).
 */
function detectLevelFromSubject(subjectName) {
  const s = String(subjectName || '').toLowerCase().trimStart();
  if (/^(igcse\/gcse|igcse\/o-level|igcse|gcse)/.test(s)) return 'igcse';
  if (/^(as\/a\s+level|as\/al|a\s+level|a-level)/.test(s)) return 'a_level';
  if (/^(below\s+igcse|below-igcse|below_igcse)/.test(s)) return 'below_igcse';
  if (/^university/.test(s)) return 'university';
  if (/^language/.test(s)) return 'language';
  if (/^test\s*prep/.test(s)) return 'test_prep';
  return null;
}

/**
 * Mirrors the findSubjectChannel() function in index.js.
 * Locates the correct text channel within a category for the given subject.
 *
 * Fallback strategy (tried in order):
 *  1. prefix + bare name in the configured category        (e.g. ig-maths)
 *  2. bare name only in the configured category            (e.g. mandarin-chinese)
 *  3. Re-detect level from subject name and retry 1 & 2   (handles missing level field)
 *  4. Try every other level config                         (last resort)
 */
async function findSubjectChannel(guild, levelKey, subjectName) {
  // Inner helper: search one level config for the channel
  const tryLevel = (key) => {
    const config = CREATEAD_LEVEL_CONFIG[key];
    if (!config) return null;

    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory &&
           c.name.toLowerCase() === config.categoryName.toLowerCase()
    );
    if (!category) {
      if (process.env.DEBUG_MIGRATEADS) console.debug(`[migrateads] category not found: "${config.categoryName}" for level="${key}"`);
      return null;
    }

    // Normalise subject: strip known level prefixes, lowercase, spaces→hyphens
    const bare = subjectName
      .replace(/^(igcse\/gcse|igcse\/o-level|igcse|as\/al|as\/a\s+level|a\s+level|a-level|below\s+igcse|below_igcse|university|language|test\s*prep)\s+/i, '')
      .toLowerCase()
      .replace(/\s+/g, '-');

    const targetName = (config.prefix + bare).toLowerCase();

    // Primary: prefix + bare name
    let channel = guild.channels.cache.find(
      c => c.parentId === category.id && c.name.toLowerCase() === targetName
    );

    // Fallback: bare name without prefix (handles channels that omit the standard prefix)
    if (!channel && config.prefix) {
      channel = guild.channels.cache.find(
        c => c.parentId === category.id && c.name.toLowerCase() === bare
      );
    }

    if (!channel) {
      if (process.env.DEBUG_MIGRATEADS) console.debug(`[migrateads] channel not found: "${targetName}" (or bare "${bare}") in category "${config.categoryName}"`);
    }
    return channel || null;
  };

  // 1. Try the supplied levelKey first
  let channel = tryLevel(levelKey);

  // 2. If not found and levelKey was 'other' (or missing), try auto-detecting
  //    the level from the subject name (handles ads without a stored level).
  if (!channel) {
    const detected = detectLevelFromSubject(subjectName);
    if (detected && detected !== levelKey) {
      channel = tryLevel(detected);
    }
  }

  // 3. Last resort: walk every remaining level config
  if (!channel) {
    for (const k of Object.keys(CREATEAD_LEVEL_CONFIG)) {
      if (k === levelKey) continue;
      channel = tryLevel(k);
      if (channel) break;
    }
  }

  if (!channel) return null;

  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
  } catch (e) {
    console.warn('findSubjectChannel: failed to update permissions:', e.message);
  }

  return channel;
}

async function main() {
  const db = loadDB();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  await client.login(BOT_TOKEN);

  await new Promise(resolve => client.once('ready', resolve));
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) {
    console.error('Guild not found:', GUILD_ID);
    await client.destroy();
    process.exit(1);
  }

  // Ensure channel cache is populated
  await guild.channels.fetch().catch(() => {});

  const allAds = Object.entries(db.createAds || {});
  const toMigrate = force
    ? allAds
    : allAds.filter(([, data]) => !data.categoryMessageId);

  if (toMigrate.length === 0) {
    console.log(force
      ? 'No ads found in the database.'
      : 'All ads already have a category message. Use --force to re-post.');
    await client.destroy();
    return;
  }

  console.log(`Migrating ${toMigrate.length} ad(s)… (force=${force})`);

  let migrated = 0;
  let skipped = 0;
  const errors = [];

  for (const [messageId, adData] of toMigrate) {
    try {
      const subject = adData.embed && adData.embed.title ? adData.embed.title : null;
      // Fall back to auto-detecting the level from the subject name so that ads
      // created before the level field was introduced are still routed correctly.
      const levelKey = adData.level || detectLevelFromSubject(subject) || 'other';
      const tutorId = adData.tutorId || null;
      const embedDescription = adData.embed && adData.embed.description ? adData.embed.description : '';

      if (!subject) {
        console.warn(`  [SKIP] ${messageId}: no subject found`);
        skipped++;
        continue;
      }

      const categoryCh = await findSubjectChannel(guild, levelKey, subject).catch(() => null);
      if (!categoryCh) {
        console.warn(`  [SKIP] ${messageId}: no category channel found for subject="${subject}" level="${levelKey}"`);
        skipped++;
        continue;
      }

      const shortContent = [
        `**${subject}**`,
        tutorId ? `Tutor: <@${tutorId}>` : null,
        embedDescription ? embedDescription.split('\n').slice(0, MAX_DESCRIPTION_LINES).join('\n') : null,
        `*See full ad in <#${FIND_A_TUTOR_CHANNEL_ID}>*`
      ].filter(Boolean).join('\n');

      const sent = await categoryCh.send({ content: shortContent }).catch(() => null);
      if (sent) {
        db.createAds[messageId].categoryChannelId = categoryCh.id;
        db.createAds[messageId].categoryMessageId = sent.id;
        saveDB(db);
        console.log(`  [OK] ${messageId} -> #${categoryCh.name} (${sent.id})`);
        migrated++;
      } else {
        console.warn(`  [SKIP] ${messageId}: failed to send to #${categoryCh.name}`);
        skipped++;
      }

      // Respect Discord rate limits
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    } catch (e) {
      console.error(`  [ERROR] ${messageId}:`, e.message);
      errors.push(messageId);
    }
  }

  console.log(`\nMigration complete!`);
  console.log(`✅ Migrated: ${migrated}`);
  console.log(`⏭️  Skipped:  ${skipped}`);
  if (errors.length > 0) {
    console.log(`❌ Errors:   ${errors.length}`);
    console.log('   Failed IDs:', errors.join(', '));
  }

  await client.destroy();
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
