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
  a_level:     { categoryName: 'A Level Tutors',     prefix: 'asl-al-' },
  below_igcse: { categoryName: 'Below IGCSE Tutors', prefix: '' },
  university:  { categoryName: 'Other Tutors',       prefix: '' },
  language:    { categoryName: 'Other Tutors',       prefix: '' },
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
 * Mirrors the findSubjectChannel() function in index.js.
 * Locates the correct text channel within a category for the given subject.
 */
async function findSubjectChannel(guild, levelKey, subjectName) {
  const config = CREATEAD_LEVEL_CONFIG[levelKey] || CREATEAD_LEVEL_CONFIG.other;

  const category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory &&
         c.name.toLowerCase() === config.categoryName.toLowerCase()
  );
  if (!category) return null;

  const bare = subjectName
    .replace(/^(igcse|a\s+level|a-level|below\s+igcse|below_igcse|university|language)\s+/i, '')
    .toLowerCase()
    .replace(/\s+/g, '-');

  const targetName = (config.prefix + bare).toLowerCase();

  const channel = guild.channels.cache.find(
    c => c.parentId === category.id && c.name.toLowerCase() === targetName
  );
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
      const levelKey = adData.level || 'other';
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
