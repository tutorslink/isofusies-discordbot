**
 * index.js
 * Ticket-matchmaker main file
 * Node 20+, discord.js v14
 *
 * Changes included
 * - All original features retained
 * - notifyStaffError helper that posts to STAFF_CHAT_ID and mentions staff roles
 * - initModmail passed notifyError to forward errors from modmail
 * - /close and modmail close flows changed to two-step select + modal (see comments)
 * - Student/tutor assignment, /student add, /student remove added
 * - Review reminders scheduling, pending reviews stored and require staff approval
 * - /reviewreminder modal to change reminder delay
 * - Timestamps in transcripts use Discord timestamp format <t:SECONDS:f>
 * - /embedcolor updates sticky and createad embed colors, now affects sticky as before
 */

import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import pkg from 'discord.js';
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  LabelBuilder,
  AttachmentBuilder
} = pkg;

// ---------------- WEB SERVER SETUP ----------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { setupWebServer } from "./webserver.js";

// ES module dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 9904;
const app = express();

// Setup web server routes (authentication, API, etc.)
setupWebServer(app);

// Start web server
app.listen(PORT, () => {
  console.log(`Webapp running on port ${PORT}`);
});

// --------------- END WEB SERVER SETUP ---------------



import initModmail from './modmail.js';
import initDemo from './demo.js';


// env
const {
  BOT_TOKEN,
  GUILD_ID,
  STAFF_ROLE_ID,
  STAFF_CHAT_ID,
  FIND_A_TUTOR_CHANNEL_ID,
  TUTORS_FEED_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  TRANSCRIPTS_CHANNEL_ID = '1443015615957696603',
  TUTOR_CHAT_CHANNEL_ID,
  TUTOR_POLICIES_CHANNEL_ID,
  MODMAIL_CATEGORY_ID,
  MODMAIL_TRANSCRIPTS_CHANNEL_ID,
  BUMP_CHANNEL_ID, // Optional: Channel ID where bump tracking should listen (if not set, listens in all channels)
  ADS_CHANNEL_ID,
  SYNC_SECRET,
  SYNC_WEBHOOK_URL
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !STAFF_ROLE_ID || !FIND_A_TUTOR_CHANNEL_ID || !TUTORS_FEED_CHANNEL_ID) {
  console.error('Missing required env vars.');
  process.exit(1);
}

// --- CreateAd categorisation (posts to find-a-tutor AND a subject channel) ---
// Dynamic discovery: channels are found at runtime by category name + subject prefix.
const CREATEAD_LEVEL_CONFIG = {
  igcse:       { categoryName: 'IGCSE Tutors',       prefix: 'ig-' },
  // 'asl-al-' is the server-defined prefix for A-Level subject channels (e.g. asl-al-maths)
  a_level:     { categoryName: 'AS/A Level Tutors',  prefix: 'asl-al-' },
  below_igcse: { categoryName: 'Below IGCSE Tutors', prefix: '' },
  university:  { categoryName: 'University Tutors',  prefix: '' },
  language:    { categoryName: 'Language Tutors',    prefix: '' },
  other:       { categoryName: 'Other Tutors',       prefix: '' },
};
const CREATEAD_LEVEL_LABELS = {
  university: 'University',
  a_level: 'A level',
  igcse: 'IGCSE',
  below_igcse: 'Below IGCSE',
  language: 'Language',
  other: 'Other'
};

const DATA_FILE = './data.json';
let db = {
  nextTicketId: 1,
  subjects: ['IGCSE Accounting', 'IGCSE Maths', 'IGCSE Add Maths'],
  subjectTutors: { 'IGCSE Maths': ['742420325559435375', '873095080938975232'] }, // tutor user ids
  initMessage: 'Hello, thanks for requesting a tutor for **{subject}**. Please tell us your topic, availability, timezone. Do not post contact info.',
  tickets: {},
  cooldowns: {},
  sticky: null, // { title, body, color, messageId }
  createAds: {}, // map messageId -> { channelId, embed, adCode, tutorId, level, ... }
  nextAdCodes: {}, // map levelKey -> next serial number (e.g. { igcse: 3, a_level: 1 })
  defaultEmbedColor: null,
  // Review system
  tutorProfiles: {}, // tutorId -> { addedAt, students: [userId,...], reviews: [], rating: {count,avg} }
  studentAssignments: {}, // userId -> { tutorId, subject, assignedAt, reviewScheduledAt }
  pendingReviews: [], // { id, studentId, tutorId, subject, rating, text, submittedAt, approved: false }
  reviewConfig: { delaySeconds: 1296000 }, // default 15 days in seconds
  // Bump leaderboard
  bumpLeaderboard: {}, // userId -> { count: number, lastBump: timestamp }
  // Modmail helpers placed by modmail.js
  _modmail_helpers: {}
};

function saveDB() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.warn('Failed to save DB', e); }
}

// Ensure labels passed to Discord input builders meet max-length requirements
function clampLabel(s, max = 45) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + '...';
}

function normalizeCreateAdLevelKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (CREATEAD_LEVEL_CONFIG[v]) return v;
  // allow some common aliases
  if (v === 'university' || v === 'uni') return 'university';
  if (v === 'a level' || v === 'alevel' || v === 'a-level') return 'a_level';
  if (v === 'below igcse' || v === 'below_igcse' || v === 'below-igcse') return 'below_igcse';
  if (v === 'language' || v === 'lang') return 'language';
  return null;
}

// Short prefix used in ad codes for each level (e.g. "IG-1", "AL-2")
const AD_CODE_PREFIXES = {
  igcse:       'IG',
  a_level:     'AL',
  university:  'Uni',
  below_igcse: 'Bel',
  language:    'Lang',
  other:       'Other',
};

/**
 * Generates a unique ad code for the given level key, e.g. "IG-1", "AL-3".
 * Increments the per-level counter in db.nextAdCodes and saves the DB.
 */
function generateAdCode(levelKey) {
  const key = levelKey || 'other';
  if (!db.nextAdCodes) db.nextAdCodes = {};
  const current = (db.nextAdCodes[key] || 0) + 1;
  db.nextAdCodes[key] = current;
  const prefix = AD_CODE_PREFIXES[key] || 'Ad';
  return `${prefix}-${current}`;
}

/**
 * Resolves an ad code (e.g. "IG-1") to the associated tutor user ID, or null
 * if no matching ad is found.
 */
function resolveAdCodeToTutorId(code) {
  if (!code || !db.createAds) return null;
  const normalised = String(code).trim().toUpperCase();
  for (const data of Object.values(db.createAds)) {
    if (data.adCode && String(data.adCode).toUpperCase() === normalised) {
      return data.tutorId || null;
    }
  }
  return null;
}

/**
 * Returns true if the given string looks like an ad code (known prefix + dash + digits).
 * Discord user IDs are purely numeric, so this safely distinguishes ad codes from user IDs.
 */
function isAdCode(value) {
  const knownPrefixes = Object.values(AD_CODE_PREFIXES).join('|');
  return new RegExp(`^(?:${knownPrefixes})-\\d+$`, 'i').test(String(value || '').trim());
}

/**
 * Infers the CREATEAD_LEVEL_CONFIG key from a subject name prefix when no
 * explicit levelKey is stored (e.g. for ads created before the level field
 * was introduced).  Returns null when the prefix is unrecognisable.
 */
function detectLevelFromSubject(subjectName) {
  const s = String(subjectName || '').toLowerCase().trimStart();
  if (/^(igcse\/gcse|igcse\/o-level|igcse|gcse)/.test(s)) return 'igcse';
  if (/^(as\/a\s+level|as\/al|a\s+level|a-level)/.test(s)) return 'a_level';
  if (/^(below\s+igcse|below-igcse|below_igcse)/.test(s)) return 'below_igcse';
  if (/^university/.test(s)) return 'university';
  if (/^language/.test(s)) return 'language';
  return null;
}

/**
 * Dynamically discovers a subject channel within the correct category for a
 * given level.  If a matching channel is found, grants ViewChannel to @everyone
 * to make it public.  Returns the channel object, or null if not found.
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
      .replace(/^(igcse\/gcse|igcse\/o-level|igcse|as\/al|as\/a\s+level|a\s+level|a-level|below\s+igcse|below_igcse|university|language)\s+/i, '')
      .toLowerCase()
      .replace(/\s+/g, '-');

    const targetName = (config.prefix + bare).toLowerCase();

    // Primary: prefix + bare name
    let channel = guild.channels.cache.find(
      c => c.parentId === category.id && c.name.toLowerCase() === targetName
    );

    // Fallback: bare name without prefix (e.g. channels that omit the standard prefix)
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

  // Make the channel public by granting ViewChannel to @everyone
  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
  } catch (e) {
    console.warn('findSubjectChannel: failed to update permissions', e);
  }

  return channel;
}

// Try to fetch a user but fail fast (timeout) to avoid interaction timeouts
// NOTE: We avoid network fetches during modal construction to prevent interaction timeouts.
// Use cached guild members / users synchronously when building selects.

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(db, parsed);
      // Migrate old delayDays to delaySeconds if needed
if (db.reviewConfig && db.reviewConfig.delayDays && !db.reviewConfig.delaySeconds) {
  db.reviewConfig.delaySeconds = db.reviewConfig.delayDays * 24 * 60 * 60;
  delete db.reviewConfig.delayDays;
  saveDB();
}
      // Normalize any literal '#tutors-link-policies' entries to the configured channel mention
      try {
        const policyMention = TUTOR_POLICIES_CHANNEL_ID ? `<#${TUTOR_POLICIES_CHANNEL_ID}>` : null;
        let migrated = false;
        if (policyMention) {
          if (db.initMessage && typeof db.initMessage === 'string' && db.initMessage.includes('#tutors-link-policies')) {
            db.initMessage = db.initMessage.split('#tutors-link-policies').join(policyMention);
            migrated = true;
          }
          if (db.createAds && typeof db.createAds === 'object') {
            for (const key of Object.keys(db.createAds)) {
              const entry = db.createAds[key];
              if (entry && entry.embed && typeof entry.embed.description === 'string' && entry.embed.description.includes('#tutors-link-policies')) {
                entry.embed.description = entry.embed.description.split('#tutors-link-policies').join(policyMention);
                migrated = true;
              }
            }
          }
        }
        if (migrated) saveDB();
      } catch (e) { /* migration shouldn't crash startup */ }
    } catch (e) {
      console.error('Failed to load DB', e);
    }
  } else {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.warn('cannot write DB', e); }
  }
}

loadDB();

// Helper function to split long messages into chunks that fit Discord's 2000 character limit
function splitMessage(content, maxLength = 2000) {
  if (content.length <= maxLength) return [content];
  const chunks = [];
  let currentChunk = '';
  const lines = content.split('\n');
  
  for (const line of lines) {
    // If a single line is too long, split it
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      // Split the long line
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.substring(i, i + maxLength));
      }
    } else if (currentChunk.length + line.length + 1 > maxLength) {
      // Current chunk would be too long, save it and start new one
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      // Add line to current chunk
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// Safe reply helper for component/select interactions to avoid Unknown interaction errors
async function safeReply(interaction, options) {
  try {
    // Prefer update if possible (edits original message)
    if (!interaction.replied && !interaction.deferred && typeof interaction.update === 'function' && interaction.message) {
      try { await interaction.update(options); return; } catch (e) { /* fallthrough */ }
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(options);
    } else {
      await interaction.followUp(options);
    }
  } catch (e) {
    // If everything fails (likely interaction token expired), log and stop.
    console.warn('safeReply failed', e);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// helpers

async function sendReviewPage(tutorId, page = 0, sortMethod = 'newest') {
    const tutorProfile = db.tutorProfiles[tutorId];
    if (!tutorProfile || !tutorProfile.reviews || tutorProfile.reviews.length === 0) {
        return { content: 'No reviews available for this tutor.' };
    }
    
    // Sort reviews
    let reviews = [...tutorProfile.reviews];
    switch (sortMethod) {
        case 'newest':
            reviews.sort((a, b) => b.submittedAt - a.submittedAt);
            break;
        case 'oldest':
            reviews.sort((a, b) => a.submittedAt - b.submittedAt);
            break;
        case 'highest':
            reviews.sort((a, b) => b.rating - a.rating);
            break;
        case 'lowest':
            reviews.sort((a, b) => a.rating - b.rating);
            break;
    }
    
    // Paginate
    const itemsPerPage = 5;
    const totalPages = Math.ceil(reviews.length / itemsPerPage);
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageReviews = reviews.slice(start, end);
    
    // Create embed
    const embed = new EmbedBuilder()
        .setTitle(`Reviews for Tutor`)
        .setDescription(`Showing ${start + 1}-${Math.min(end, reviews.length)} of ${reviews.length} reviews`)
        .addFields({ name: 'Sort Method', value: sortMethod, inline: true })
        .addFields({ name: 'Page', value: `${page + 1}/${totalPages}`, inline: true })
        .addFields({ name: 'Average Rating', value: tutorProfile.rating?.avg ? `${tutorProfile.rating.avg.toFixed(1)} ⭐` : 'No rating', inline: true })
        .setTimestamp();
    
    // Add review fields
    for (let i = 0; i < pageReviews.length; i++) {
        const review = pageReviews[i];
        const date = `<t:${Math.floor(review.submittedAt / 1000)}:R>`;
        const stars = '⭐'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
        embed.addFields({
            name: `Review ${start + i + 1} ${stars}`,
            value: `${review.text.substring(0, 200)}${review.text.length > 200 ? '...' : ''}\n*${date}*`,
            inline: false
        });
    }
    
    // Create buttons
    const buttons = [];
    
    // Previous button
    if (page > 0) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`review_prev|${tutorId}|${page}|${sortMethod}`)
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary));
    }
    
    // Next button
    if (page < totalPages - 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`review_next|${tutorId}|${page}|${sortMethod}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary));
    }
    
    // Sort select menu
    const sortOptions = [
        { label: 'Newest First', value: 'newest' },
        { label: 'Oldest First', value: 'oldest' },
        { label: 'Highest Rated', value: 'highest' },
        { label: 'Lowest Rated', value: 'lowest' }
    ];
    
    const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`review_sort|${tutorId}|${page}`)
    .setPlaceholder('Sort by...')
    .addOptions(sortOptions.map(opt => new StringSelectMenuOptionBuilder()
        .setLabel(opt.label)
        .setValue(opt.value)
        .setDefault(opt.value === sortMethod)
    ));
    
    const rows = [];
    if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(buttons));
    }
    rows.push(new ActionRowBuilder().addComponents(selectMenu));
    
    return {
        embeds: [embed],
        components: rows
    };
}

// Helper function to update review threads for a tutor when new reviews are added
async function updateReviewThreadsForTutor(tutorId) {
    try {
        // Find all ads that have review threads for this tutor
        for (const [messageId, adData] of Object.entries(db.createAds || {})) {
            if (adData.tutorId === tutorId && adData.reviewThreadId) {
                try {
                    const channel = await client.channels.fetch(adData.channelId).catch(() => null);
                    if (!channel) continue;
                    
                    const thread = await channel.threads.fetch(adData.reviewThreadId).catch(() => null);
                    if (!thread) continue;
                    
                    // Get the first message in the thread (the reviews embed)
                    const messages = await thread.messages.fetch({ limit: 1 }).catch(() => null);
                    if (messages && messages.size > 0) {
                        const firstMessage = messages.first();
                        const messageData = await sendReviewPage(tutorId, 0, 'newest');
                        if (messageData && firstMessage) {
                            await firstMessage.edit(messageData).catch((err) => {
                                console.warn('Failed to update review thread message', err);
                            });
                        }
                    } else {
                        // No message yet, send a new one
                        const messageData = await sendReviewPage(tutorId, 0, 'newest');
                        if (messageData) {
                            await thread.send(messageData).catch((err) => {
                                console.warn('Failed to send review thread message', err);
                            });
                        }
                    }
                } catch (e) {
                    console.warn(`Failed to update review thread for ad ${messageId}`, e);
                }
            }
        }
    } catch (e) {
        console.warn('updateReviewThreadsForTutor failed', e);
    }
}

function generateTicketNumber() {
  const id = db.nextTicketId || 1;
  db.nextTicketId = id + 1;
  saveDB();
  return String(id);
}

function getStaffRoleIds() {
  return (STAFF_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isStaff(member) {
  if (!member) return false;
  const staffRoleIds = getStaffRoleIds();
  for (const rid of staffRoleIds) {
    if (member.roles?.cache?.has && member.roles.cache.has(rid)) return true;
  }
  return false;
}

/**
 * notifyStaffError(err, source, context)
 * - err: Error or object
 * - source: short string describing module or location
 * - context: optional, interaction or message object to extract user id / command
 *
 * Defensive, best-effort, does not throw
 */
async function notifyStaffError(err, source = '(unknown)', context = null) {
  try {
    const staffChatId = process.env.STAFF_CHAT_ID || STAFF_CHAT_ID;
    if (!staffChatId) {
      console.warn('notifyStaffError: no STAFF_CHAT_ID configured');
      return;
    }

    let raw = '';
    if (err instanceof Error) raw = err.stack || err.message || String(err);
    else {
      try { raw = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch { raw = String(err); }
    }

    // Truncate to 1000 chars to leave room for code block markers (```) and ensure it fits in embed field (1024 char limit)
    const safe = String(raw).replace(/```/g, "'''").substring(0, 1000);

    let userId = '';
    const extra = [];
    try {
      if (context) {
        if (context.user) userId = context.user?.id || '';
        else if (context.author) userId = context.author?.id || '';
        else if (context.member && context.member.user) userId = context.member.user.id || '';
        if (context && context.commandName) extra.push(`command: ${context.commandName}`);
        if (context && context.customId) extra.push(`customId: ${context.customId}`);
        if (context && context.channelId) extra.push(`channelId: ${context.channelId}`);
      }
    } catch (e) { /* ignore */ }

    const mentionText = getStaffRoleIds().length ? getStaffRoleIds().map(r => `<@&${r}>`).join(' ') : '';

    // Ensure the field value doesn't exceed 1024 characters (Discord limit)
    const errorFieldValue = `\`\`\`\n${safe}\n\`\`\``;
    const finalErrorValue = errorFieldValue.length > 1024 ? errorFieldValue.substring(0, 1021) + '...' : errorFieldValue;

    const embed = new EmbedBuilder()
      .setTitle('Bot Error Alert')
      .setDescription(`**Source:** ${String(source).substring(0, 250)}\n${userId ? `**User ID:** ${userId}\n` : ''}${extra.length ? `**Context:** ${extra.join(', ')}\n` : ''}`)
      .addFields({ name: 'Error (truncated)', value: finalErrorValue })
      .setTimestamp();

    // try fetch channel
    let ch = null;
    try {
      const g = client.guilds.cache.get(GUILD_ID) || (GUILD_ID ? await client.guilds.fetch(GUILD_ID).catch(() => null) : null);
      if (g) {
        try { ch = await g.channels.fetch(staffChatId).catch(() => null); } catch { ch = null; }
      }
    } catch (e) { ch = null; }

    if (!ch) {
      try { ch = await client.channels.fetch(staffChatId).catch(() => null); } catch (e) { ch = null; }
    }
    if (!ch) {
      console.warn('notifyStaffError: staff channel not found', staffChatId);
      return;
    }

    try {
      await ch.send({ content: mentionText || undefined, embeds: [embed] }).catch(() => {});
    } catch (e) {
      console.warn('notifyStaffError send failed', e);
    }
  } catch (e) {
    console.warn('notifyStaffError internal failure', e);
  }
}

// register modmail, pass notifier
try {
  initModmail({
    client,
    db,
    saveDB,
    config: {
      MODMAIL_CATEGORY_ID: MODMAIL_CATEGORY_ID ?? MODMAIL_CATEGORY_ID,
      MODMAIL_TRANSCRIPTS_CHANNEL_ID: MODMAIL_TRANSCRIPTS_CHANNEL_ID ?? MODMAIL_TRANSCRIPTS_CHANNEL_ID
    },
    notifyError: async (err, ctx = {}) => {
      try {
        await notifyStaffError(err, ctx.module || 'modmail', ctx);
      } catch (notifyErr) {
        console.warn('notifyStaffError failed from modmail notifyError', notifyErr);
      }
    }
  });
} catch (e) {
  console.warn('initModmail threw', e);
  try { notifyStaffError(e, 'initModmail'); } catch (err) { console.warn('notify staff failed for initModmail', err); }
}

// register demo module
try {
  // Make db accessible to demo.js
  global.demoDB = db;
  initDemo(client);
} catch (e) {
  console.warn('initDemo threw', e);
  try { notifyStaffError(e, 'initDemo'); } catch (err) { console.warn('notify staff failed for initDemo', err); }
}

// centralised sticky repost helper, given a channel object, with a short lock to prevent duplicate reposts
const _stickyLocks = new Set();
async function repostStickyInChannel(channel) {
  if (!channel || !db.sticky) return null;
  const lockKey = `sticky:${channel.id}`;
  if (_stickyLocks.has(lockKey)) return null;
  _stickyLocks.add(lockKey);
  try {
    // delete old sticky if present
    if (db.sticky.messageId) {
      try {
        const prev = await channel.messages.fetch(db.sticky.messageId).catch(() => null);
        if (prev && prev.deletable) await prev.delete().catch(() => {});
      } catch (e) {}
    }
    const embed = new EmbedBuilder().setTitle(db.sticky.title || undefined).setDescription(db.sticky.body || '').setTimestamp();
    const color = db.sticky.color || db.defaultEmbedColor || null;
    if (color) {
      try { embed.setColor(String(color)); } catch (e) {}
    }
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      db.sticky.messageId = sent.id;
      saveDB();
      return sent;
    }
  } catch (e) {
    console.warn('repostStickyInChannel failed', e);
    try { await notifyStaffError(e, 'repostStickyInChannel'); } catch (err) {}
  } finally {
    setTimeout(() => _stickyLocks.delete(lockKey), 1500);
  }
  return null;
}

// Post to tutors feed, create thread, update ticket object
async function postToTutorsFeed(guild, ticketCode, subject, firstMessage, ticket) {
  const tutorsFeed = await guild.channels.fetch(TUTORS_FEED_CHANNEL_ID).catch(() => null);
  if (!tutorsFeed) throw new Error('Tutors feed channel not found');

  const tutorIds = db.subjectTutors[subject] || [];
  const mentionText = tutorIds.length ? '\n\nNotifying: ' + tutorIds.map(id => `<@${id}>`).join(' ') : '';
  const content = `New request, Student **${ticketCode}**, Subject: **${subject}**\nFirst message: ${firstMessage}\n\nUse /reply ${ticketCode} <message> to reply.${mentionText}`;

  const tutorsMessage = await tutorsFeed.send({ content }).catch(err => { throw err; });
  const thread = await tutorsMessage.startThread({ name: `Conversation ${ticketCode}`, autoArchiveDuration: 1440 }).catch(() => null);
  if (thread) ticket.tutorThreadId = thread.id;
  ticket.tutorMessageId = tutorsMessage.id;
  saveDB();
  return { tutorsMessage, thread };
}

// Grant tutor access
async function grantTutorAccess(userId) {
  const chIds = [
    TUTORS_FEED_CHANNEL_ID,
    TUTOR_CHAT_CHANNEL_ID
  ].filter(Boolean);

  for (const chId of chIds) {
    try {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch) { console.warn(`grantTutorAccess, channel ${chId} not found`); continue; }
      const guild = ch.guild;
      if (!guild) { console.warn(`grantTutorAccess, channel ${chId} has no guild`); continue; }

      try {
        await ch.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }).catch(() => {});
        for (const rid of getStaffRoleIds()) {
          await ch.permissionOverwrites.edit(rid, { ViewChannel: true, SendMessages: true }).catch(() => {});
        }
      } catch (e) {}

      let member = null;
      try { member = await guild.members.fetch(userId).catch(() => null); } catch (e) { member = null; }

      try {
        const target = member || String(userId);
        await ch.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true });
        console.log(`grantTutorAccess: granted ${userId} on ${chId}`);
      } catch (err) {
        console.warn(`grantTutorAccess per-channel error for ${userId} on ${chId}`, err?.message || err);
        if (!member) {
          try {
            await ch.permissionOverwrites.edit(String(userId), { ViewChannel: true, SendMessages: true });
            console.log(`grantTutorAccess fallback by id: granted ${userId} on ${chId}`);
          } catch (err2) {
            console.warn(`grantTutorAccess fallback failed for ${userId} on ${chId}`, err2?.message || err2);
          }
        }
      }
    } catch (e) {
      console.warn('grantTutorAccess outer error', e);
    }
  }
}

// Revoke tutor access and remove students assignment for that tutor
async function revokeTutorAccess(userId) {
  const chIds = [
    TUTORS_FEED_CHANNEL_ID,
    TUTOR_CHAT_CHANNEL_ID
  ].filter(Boolean);

  for (const chId of chIds) {
    try {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch) { console.warn(`revokeTutorAccess, channel ${chId} not found`); continue; }
      const guild = ch.guild;
      if (!guild) { console.warn(`revokeTutorAccess, channel ${chId} has no guild`); continue; }

      try {
        const ow = ch.permissionOverwrites.resolve(String(userId));
        if (ow) {
          await ow.delete().catch((err) => { console.warn(`revokeTutorAccess failed to delete overwrite for ${userId} on ${chId}`, err?.message || err); });
          console.log(`revokeTutorAccess: removed overwrite for ${userId} on ${chId}`);
        } else {
          await ch.permissionOverwrites.edit(String(userId), { ViewChannel: false, SendMessages: false }).catch((err) => {
            console.warn(`revokeTutorAccess: set ViewChannel=false for ${userId} on ${chId}`, err?.message || err);
          });
          console.log(`revokeTutorAccess: set ViewChannel=false for ${userId} on ${chId}`);
        }
      } catch (err) {
        console.warn(`revokeTutorAccess per-channel error for ${userId} on ${chId}`, err?.message || err);
      }
    } catch (e) {
      console.warn('revokeTutorAccess outer error', e);
    }
  }

  // remove student assignments for this tutor
  try {
    for (const sid of Object.keys(db.studentAssignments || {})) {
      const asg = db.studentAssignments[sid];
      if (asg && String(asg.tutorId) === String(userId)) {
        delete db.studentAssignments[sid];
      }
    }
    if (db.tutorProfiles && db.tutorProfiles[userId]) {
      delete db.tutorProfiles[userId];
    }
    saveDB();
  } catch (e) {
    console.warn('revokeTutorAccess cleanup failed', e);
  }
}

// register slash commands
async function registerCommands() {
  const subjectChoices = db.subjects.slice(0, 25).map(s => ({ name: s, value: s }));
  const restCommands = [
    {
      name: 'enquire',
      description: 'Create an enquiry ticket, choose a subject',
      options: [{ name: 'subject', description: 'Choose the subject', type: 3, required: true, choices: subjectChoices }]
    },
    {
      name: 'reply',
      description: 'Reply to a student, format: /reply CODE message',
      options: [
        { name: 'code', description: 'Ticket code to reply to', type: 3, required: true },
        { name: 'message', description: 'Your reply to the student', type: 3, required: true }
      ]
    },
    {
      name: 'close',
      description: 'Close a ticket (staff only), opens a flow to capture reason and assignment',
      options: [
        { name: 'code', description: 'Ticket code to close', type: 3, required: true }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'subject',
      description: 'Manage subjects (staff add/remove/list)',
      options: [
        { name: 'action', description: 'add, remove, or list', type: 3, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }] },
        { name: 'subject', description: 'Subject name for add/remove', type: 3, required: false }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'tutor',
      description: 'Manage tutor user IDs or view info',
      options: [
        { name: 'action', description: 'add, remove, list, info, or notes', type: 3, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }, { name: 'info', value: 'info' }, { name: 'notes', value: 'notes' }] },
        { name: 'userid', description: 'User ID or ad code (e.g. IG-1) for info/notes, User ID for add/remove', type: 3, required: false },
        { name: 'subject', description: 'Subject for mapping', type: 3, required: false }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'createad',
      description: 'Create an ad in #find-a-tutor, modal supports optional color and tutor assignment',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'editad',
      description: 'Edit an existing ad by message id, preloads content',
      options: [{ name: 'messageid', description: 'Message id of the ad to edit', type: 3, required: true }],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'sticky',
      description: 'Create or edit the sticky welcome message in find-a-tutor',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'embedcolor',
      description: 'Set default embed color hex e.g. #00ff00',
      options: [{ name: 'hex', description: 'Hex color, include #', type: 3, required: true }],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'editinit', description: 'Open modal to edit the initial ticket message (staff only)', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() },
    { name: 'help', description: 'Show available user commands' },
    { name: 'staffhelp', description: 'Show staff commands', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() },
    { name: 'bumpleaderboard', description: 'Show the bump leaderboard - see who has bumped the server the most!' },
    // student & review commands - FIXED: Added missing description for 'action' option
    { name: 'student', description: 'Manage student assignments, add or remove student from tutor', options: [
        { name: 'action', type: 3, required: true, description: 'Add or remove a student from a tutor', choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }] },
        { name: 'studentid', type: 3, required: true, description: 'Student user id' },
        { name: 'tutorid', type: 3, required: true, description: 'Tutor user id' },
        { name: 'subject', type: 3, required: false, description: 'Subject (optional)' }
      ], default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'reviewreminder', description: 'Set review reminder delay in seconds', options: [
        { name: 'seconds', type: 3, required: true, description: 'Number of seconds to wait before sending review reminder' }
      ], default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'startdemo', description: 'Start a demo recording session', options: [
        { name: 'student', type: 6, required: true, description: 'The student user' },
        { name: 'title', type: 3, required: true, description: 'Recording title' }
      ], default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'authentication', description: 'Generate authentication code for webapp access (staff only)', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() },
    {
      name: 'migrateads',
      description: 'Re-post all existing ads into their category channels with a short version (staff only)',
      options: [
        { name: 'force', description: 'Re-post even if a category message already exists', type: 5, required: false }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'exportchannels', description: 'Export all guild categories and channels as JSON (staff only)', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() }
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: restCommands });
    console.log('Commands registered');
  } catch (e) {
    console.error('Failed to register commands', e);
    try { await notifyStaffError(e, 'registerCommands'); } catch (err) {}
  }
}

client.once('ready', async () => {
  console.log(`Ready as ${client.user.tag}`);
  await registerCommands();
  try { client.user.setActivity('DM for ModMail', { type: 3 }); } catch (e) {}
});

// process handlers
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason);
  try { notifyStaffError(reason, 'unhandledRejection'); } catch (e) { console.warn('notify failed', e); }
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
  try { notifyStaffError(err, 'uncaughtException'); } catch (e) { console.warn('notify failed', e); }
});

// --- Interaction handling ---
// We'll preserve original logic but add the new flows:
// - /close now starts a select + modal flow so staff can mark whether student hired a tutor, which tutor, subject, reason
// - /createad modal has optional tutor select (subject's tutors) and thread creation is supported in createad modal submit
client.on('interactionCreate', async (interaction) => {
  try {
    // Skip commands handled by demo.js immediately to prevent conflicts
    if (interaction.isChatInputCommand() && 
        (interaction.commandName === 'startdemo' || interaction.commandName === 'authentication')) {
      return; // Let demo.js handle these
    }
    
    // Log all modal submits at the top level
    if (interaction.isModalSubmit()) {
      console.log(`[INTERACTION] Modal submit received - customId: ${interaction.customId}, type: ${interaction.type}`);
    }
    
    // BUTTONS
    if (interaction.isButton()) {
      const custom = interaction.customId || '';

      // Handle View Full Details button
      if (custom.startsWith('view_full_details|')) {
        const subject = custom.split('|')[1];
        
        // Find the ad message to get full details
        let adData = null;
        for (const [msgId, data] of Object.entries(db.createAds || {})) {
          if (data.embed && data.embed.title === subject) {
            adData = data;
            break;
          }
        }
        
        if (!adData || !adData.fullDetails) {
          return interaction.reply({ content: 'Could not find ad details. Please try again later.', ephemeral: true });
        }

        const details = adData.fullDetails;
        const policiesChannelMention = TUTOR_POLICIES_CHANNEL_ID ? `<#${TUTOR_POLICIES_CHANNEL_ID}>` : '#tutors-link-policies';
        
        // Build full details embed
        let detailsMessage = '';
        detailsMessage += `**Subject Level:** ${details.subjectLevel || 'N/A'}\n`;
        detailsMessage += `**Subject Codes:** ${details.subjectCodes || 'N/A'}\n\n`;
        
        detailsMessage += `**Languages:** ${details.languages || 'N/A'}\n`;
        detailsMessage += `**Class Type:** ${details.classType || 'N/A'}\n`;
        detailsMessage += `**Class Duration:** ${details.classDuration || 'N/A'}\n`;
        detailsMessage += `**Monthly Schedule:** ${details.monthlySchedule || 'N/A'}\n`;
        detailsMessage += `**Price:** $${details.price || 'Contact for pricing'}\n`;
        detailsMessage += `**Timezone:** ${details.timezone || 'N/A'}\n\n`;
        
        if (details.tutorMessage) {
          detailsMessage += `**Message from Tutor:**\n${details.tutorMessage}\n\n`;
        }
        
        if (details.testimonials) {
          detailsMessage += `**Student Testimonials:**\n${details.testimonials}\n\n`;
        }
        
        detailsMessage += `**Payment Terms:** ${details.paymentTerms || '100% upfront before classes begin'}\n\n`;
        detailsMessage += `You'll be connected with the tutor once the initial payment is confirmed.\n\n`;
        detailsMessage += `Make sure you follow ${policiesChannelMention} throughout the entire process.\n\n`;
        detailsMessage += `Once you're ready to pay, DM <@${client.user.id}> and you will be guided to the next steps.`;
        
        const detailsEmbed = new EmbedBuilder()
          .setTitle(`${subject} - Full Details`)
          .setDescription(detailsMessage)
          .setTimestamp();
        
        if (adData.adCode) detailsEmbed.setFooter({ text: `Ad Code: ${adData.adCode}` });
        
        if (adData.embed && adData.embed.color) {
          try { detailsEmbed.setColor(adData.embed.color); } catch (e) {}
        }
        
        // Create button row with Talk to Tutors button for ephemeral message
        const detailsRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ad_enquire|${subject}`).setLabel('Talk to Tutors!').setStyle(ButtonStyle.Success)
        );
        
        return interaction.reply({ embeds: [detailsEmbed], components: [detailsRow], ephemeral: true });
      }

      if (custom.startsWith('ad_enquire|')) {
        // unchanged
        const subject = custom.split('|')[1];
        const user = interaction.user;
        const last = db.cooldowns[user.id] || 0;
        const cooldownMs = 3 * 60 * 1000;
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          const msLeft = cooldownMs - elapsed;
          const secs = Math.ceil(msLeft / 1000);
          return interaction.reply({ content: `Please wait ${secs}s before opening another ticket.`, ephemeral: true });
        }

        await interaction.reply({ content: `Creating ticket for ${subject}...`, ephemeral: true }).catch(() => {});
        const guild = interaction.guild;
        const code = generateTicketNumber();

        const overwrites = [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ...getStaffRoleIds().map(rid => ({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] })),
          { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.EmbedLinks] }
        ];
        const channelData = { name: `ticket-${code}`, type: 0, permissionOverwrites: overwrites };
        if (TICKET_CATEGORY_ID) channelData.parent = TICKET_CATEGORY_ID;
        const ticketChannel = await guild.channels.create(channelData).catch(err => { console.error('create channel failed', err); try { notifyStaffError(err, 'ad_enquire create channel', interaction); } catch {} return null; });
        if (!ticketChannel) return interaction.editReply({ content: `Failed to create ticket channel.`, ephemeral: true }).catch(() => {});

        const initMsg = db.initMessage.replace('{subject}', subject);
        await ticketChannel.send({ content: `<@${user.id}>\n${initMsg}` }).catch(() => {});

        db.tickets[code] = {
          ticketChannelId: ticketChannel.id,
          studentId: user.id,
          tutorMessageId: null,
          tutorThreadId: null,
          subject,
          approved: false,
          awaitingApproval: false,
          tutorCount: 0,
          tutorMap: {},
          messages: [],
          createdAt: Date.now()
        };
        db.cooldowns[user.id] = Date.now();
        saveDB();

        await interaction.editReply({ content: `Ticket created, code **${code}**. See <#${ticketChannel.id}>.` }).catch(() => {});
        await ticketChannel.send(`Ticket ${code} created for ${user.tag}, subject: ${subject}`).catch(() => {});
        return;
      }
      // Button to open the create-ad modal after usernames were resolved
      if (custom && custom.startsWith('open_createad_modal|')) {
        const parts = custom.split('|');
        const requester = parts[1];
        const subjectKey = parts[2] || '';
        const origin = parts[3] || null;
        const originChannel = parts[4] || null;
        const levelKeyFromModmail = parts[5] || null; // For modmail: level is pre-selected
        let levelKey = normalizeCreateAdLevelKey(subjectKey) || (levelKeyFromModmail ? normalizeCreateAdLevelKey(levelKeyFromModmail) : 'other');
        if (String(interaction.user.id) !== String(requester) && !isStaff(interaction.member)) {
          return interaction.reply({ content: 'Only the command invoker or staff may open this modal.', ephemeral: true });
        }

        // Build the modal now using cached/db usernames (fast)
        try {
          // Build tutor options for dropdown
          const allTutorIds = Array.from(new Set(Object.values(db.subjectTutors || {}).flat()));
          const tutorOptions = [];
          tutorOptions.push(new StringSelectMenuOptionBuilder().setLabel('None - General Ad').setValue('none').setDescription('No specific tutor'));
          for (const tid of allTutorIds.slice(0, 24)) {
            let label = `User ID: ${tid}`;
            let description = '';
            try {
              const cachedMember = interaction.guild?.members?.cache?.get(tid) || null;
              const user = cachedMember?.user || client.users.cache.get(tid) || null;
              if (user) {
                label = user.username;
                description = `(${user.tag})`;
              } else if (db.tutorProfiles && db.tutorProfiles[tid] && db.tutorProfiles[tid].username) {
                label = db.tutorProfiles[tid].username;
                if (db.tutorProfiles[tid].tag) description = `(${db.tutorProfiles[tid].tag})`;
              }
            } catch (e) {}
            const opt = new StringSelectMenuOptionBuilder().setLabel(clampLabel(label, 100)).setValue(String(tid).substring(0, 100));
            if (description && description.trim()) opt.setDescription(clampLabel(description, 50));
            tutorOptions.push(opt);
          }

          const subjectOptions = (db.subjects || []).slice(0, 25).map(s => new StringSelectMenuOptionBuilder().setLabel(clampLabel(s, 100)).setValue(s.substring(0, 100)).setDescription(clampLabel(`Select ${s}`, 50)));
          const subjectSelect = new StringSelectMenuBuilder().setCustomId('ad_subject').setPlaceholder('Select a subject').addOptions(subjectOptions).setRequired(true);
          const subjectLabel = new LabelBuilder().setLabel(clampLabel('Subject')).setStringSelectMenuComponent(subjectSelect);
          const tutorSelect = new StringSelectMenuBuilder().setCustomId('ad_tutor').setPlaceholder('Select a tutor (optional)').addOptions(tutorOptions);
          const tutorLabel = new LabelBuilder().setLabel(clampLabel('Tutor (Optional)')).setStringSelectMenuComponent(tutorSelect);

          const subjectDetailsInput = new TextInputBuilder().setCustomId('ad_subject_details').setLabel(clampLabel('Subject Level & Codes')).setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(clampLabel('Subject Level: \nSubject codes: ', 1000));
          const tutorDetailsInput = new TextInputBuilder().setCustomId('ad_tutor_details').setLabel(clampLabel('Tutor Details & Pricing')).setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(clampLabel('Languages: \nClass Type: \nClass Duration: \nClasses/week: \nClasses/month: \nPrice per Class (USD) for Group classes: \nTime zone:', 1000));
          const optionalFieldsInput = new TextInputBuilder().setCustomId('ad_optional_fields').setLabel(clampLabel('Optional: Message, Testimonials, Payment, Color, Role')).setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(clampLabel('Message from tutor:\nStudent Testimonials:\nPayment Terms: 100% upfront before classes begin\nColor: \nRole ID: ', 1000));

          const modal = new ModalBuilder()
            .setCustomId(`createad_modal|${interaction.id}|${levelKey}|${origin || ''}|${originChannel || ''}|${subjectKey}`)
            .setTitle('Create Ad Details')
            .addComponents(
              subjectLabel,
              tutorLabel,
              new ActionRowBuilder().addComponents(subjectDetailsInput),
              new ActionRowBuilder().addComponents(tutorDetailsInput),
              new ActionRowBuilder().addComponents(optionalFieldsInput)
            );
          await interaction.showModal(modal);
        } catch (err) {
          console.error('open_createad_modal failed', err);
          try { notifyStaffError(err, 'open_createad_modal', interaction); } catch (e) {}
          await interaction.reply({ content: 'Could not open ad creation modal, try again.', ephemeral: true }).catch(() => {});
        }
        return;
      }

            // Leave a review button
      if (custom.startsWith('review_start|')) {
          const [, studentId, tutorId] = custom.split('|');
          
          // Verify the user clicking is the student
          if (interaction.user.id !== studentId) {
              return interaction.reply({ content: 'Only the student can leave a review for their tutor.', ephemeral: true });
          }
          
          // Create a modal for the review
          const modal = new ModalBuilder()
              .setCustomId(`review_modal|${studentId}|${tutorId}`)
              .setTitle('Leave a Review');
          
          // Rating input (1-5)
          const ratingInput = new TextInputBuilder()
              .setCustomId('review_rating')
              .setLabel('Rating (1-5 stars)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('Enter a number from 1 to 5')
              .setMaxLength(1);
          
          // Review text
          const textInput = new TextInputBuilder()
              .setCustomId('review_text')
              .setLabel('Review Text')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setPlaceholder('Share your experience with this tutor...')
              .setMaxLength(1000);
          
          modal.addComponents(
              new ActionRowBuilder().addComponents(ratingInput),
              new ActionRowBuilder().addComponents(textInput)
          );
          
          await interaction.showModal(modal);
          return;
      }

            // Review approve or deny button
      if (custom.startsWith('approve_review|') || custom.startsWith('deny_review|')) {
          const [action, reviewId] = custom.split('|');
          const review = db.pendingReviews.find(r => r.id === reviewId);
          
          if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true });
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can moderate reviews.', ephemeral: true });
          
          // Remove from pending
          db.pendingReviews = db.pendingReviews.filter(r => r.id !== reviewId);
          
          if (action === 'approve_review') {
              // Add to tutor's profile
              const tutorProfile = db.tutorProfiles[review.tutorId] || { reviews: [], rating: { count: 0, avg: 0 } };
              if (!tutorProfile.reviews) tutorProfile.reviews = [];
              if (!tutorProfile.rating) tutorProfile.rating = { count: 0, avg: 0 };
              
              tutorProfile.reviews.push(review);
              
              // Update rating
              const oldCount = tutorProfile.rating.count;
              const oldAvg = tutorProfile.rating.avg;
              const newCount = oldCount + 1;
              const newAvg = ((oldAvg * oldCount) + review.rating) / newCount;
              
              tutorProfile.rating = { count: newCount, avg: newAvg };
              db.tutorProfiles[review.tutorId] = tutorProfile;
              saveDB();
              
              // Update review threads for this tutor
              try {
                  await updateReviewThreadsForTutor(review.tutorId);
              } catch (e) {
                  console.warn('Failed to update review threads', e);
              }
              
              // Notify tutor
              try {
                  const tutorUser = await client.users.fetch(review.tutorId).catch(() => null);
                  if (tutorUser) {
                      await tutorUser.send(`A student left you a ${'⭐'.repeat(review.rating)} star review!\n"${review.text.substring(0, 500)}"`);
                  }
              } catch (e) { console.warn('Failed to DM tutor about review', e); }
              
              await interaction.update({ 
                  content: `✅ Review approved and added to tutor's profile.`, 
                  embeds: [], 
                  components: [] 
              });
          } else {
              await interaction.update({ 
                  content: `❌ Review denied and removed.`, 
                  embeds: [], 
                  components: [] 
              });
          }
          
          saveDB();
          return;
      }

      // approve / deny buttons (unchanged except notifyStaffError on modal errors)
      if (custom.startsWith('approve|') || custom.startsWith('deny|')) {
        const [act, code] = custom.split('|');
        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true });
        if (!isStaff(interaction.member)) return safeReply(interaction, { content: 'Only staff can do this.', ephemeral: true });

        if (act === 'deny') {
          if (ticket.approved) {
            return interaction.reply({ content: `Ticket ${code} is already approved, you cannot deny it now.`, ephemeral: true });
          }
          if (interaction.replied || interaction.deferred) {
            return interaction.followUp({ content: 'Could not open deny modal, try again.', ephemeral: true });
          }
          const modal = new ModalBuilder().setCustomId(`deny_modal|${code}`).setTitle(`Deny ticket ${code}`);
          const reasonInput = new TextInputBuilder().setCustomId('deny_reason').setLabel('Reason for denial (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
          modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
          try { await interaction.showModal(modal); } catch (err) { console.error('showModal failed', err); try { notifyStaffError(err, 'interactionCreate showModal deny_modal', interaction); } catch {} try { await interaction.followUp({ content: 'Could not open deny modal, try again.', ephemeral: true }); } catch {} }
          return;
        }

        if (act === 'approve') {
          if (!db.tickets[code]) return interaction.reply({ content: `Ticket ${code} not found.`, ephemeral: true });
          if (ticket.approved) return interaction.reply({ content: `Ticket ${code} already approved.`, ephemeral: true });

          await interaction.reply({ content: `Approving ticket ${code} and notifying tutors...`, ephemeral: true }).catch(() => {});
          const guild = interaction.guild;

          // build firstMessage
          let firstMessageText = '(no message found)';
          if (ticket.messages && ticket.messages.length > 0) {
            const m = ticket.messages.find(x => x.who === 'Student') || ticket.messages[0];
            if (m) {
              if (m.text && m.text.trim().length > 0) firstMessageText = m.text;
              else if (m.attachments && m.attachments.length) firstMessageText = `Attachment(s): ${m.attachments.join(' ')}`;
            }
          } else {
            try {
              const ch = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
              if (ch) {
                const fetched = await ch.messages.fetch({ limit: 50 }).catch(() => null);
                const studentMsg = fetched ? Array.from(fetched.values()).find(m => !m.author.bot && m.author.id === ticket.studentId) : null;
                if (studentMsg) {
                  if (studentMsg.content && studentMsg.content.trim().length > 0) firstMessageText = studentMsg.content;
                  else if (studentMsg.attachments && studentMsg.attachments.size) firstMessageText = `Attachment(s): ${Array.from(studentMsg.attachments.values()).map(a => a.url).join(' ')}`;
                }
              }
            } catch (e) { /* ignore */ }
          }

          try {
            await postToTutorsFeed(interaction.guild, code, ticket.subject, firstMessageText, ticket);
            ticket.approved = true;
            if (ticket.awaitingApproval) delete ticket.awaitingApproval;
            saveDB();
            try {
              const tchan = await interaction.guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
              if (tchan) await tchan.send('Ticket approved by staff, tutors notified.').catch(() => {});
            } catch (e) {}
            await interaction.editReply({ content: `Ticket ${code} approved, tutors notified.` }).catch(() => {});
          } catch (e) {
            console.error('approve flow failed', e);
            try { await notifyStaffError(e, 'approve flow', interaction); } catch (err) {}
            try { await interaction.editReply({ content: `Failed to notify tutors for ${code}.`, ephemeral: true }); } catch {}
          }
          return;
        }
      }

      // Review Redact button
      if (custom.startsWith('redact_review|')) {
          const reviewId = custom.split('|')[1];
          const review = db.pendingReviews.find(r => r.id === reviewId);
          
          if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true });
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can redact reviews.', ephemeral: true });
          
          const modal = new ModalBuilder()
              .setCustomId(`redact_review_modal|${reviewId}`)
              .setTitle('Redact Review Text');
          
          const textInput = new TextInputBuilder()
              .setCustomId('redacted_text')
              .setLabel('Redacted Review Text')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setValue(review.text)
              .setPlaceholder('Edit the review to remove personal information...')
              .setMaxLength(1000);
          
          modal.addComponents(new ActionRowBuilder().addComponents(textInput));
          
          await interaction.showModal(modal);
          return;
      }

      // Add these button handlers in the button interaction section
      if (custom.startsWith('review_prev|') || custom.startsWith('review_next|')) {
          const [action, tutorId, currentPage, sortMethod] = custom.split('|');
          const page = parseInt(currentPage) || 0;
          const newPage = action === 'review_prev' ? page - 1 : page + 1;

          try {
            const messageData = await sendReviewPage(tutorId, newPage, sortMethod);
            if (messageData) {
              await interaction.update(messageData).catch(() => interaction.deferUpdate().catch(() => {}));
            } else {
              await interaction.deferUpdate().catch(() => {});
            }
          } catch (e) {
            console.error('Failed to paginate reviews via buttons', e);
            try { await notifyStaffError(e, 'review pagination button', interaction); } catch (err) {}
            await interaction.deferUpdate().catch(() => {});
          }
          return;
      }

      // FIX: Add the missing button handler for opening the close modal
      if (custom.startsWith('open_close_modal|')) {
        const code = custom.split('|')[1];
        console.log(`[OPEN CLOSE MODAL] Button clicked for ticket ${code}`);
        const ticket = db.tickets[code];
        if (!ticket) {
          console.log(`[OPEN CLOSE MODAL] Ticket ${code} not found`);
          return interaction.reply({ content: 'Ticket not found.', ephemeral: true });
        }
        if (!isStaff(interaction.member)) {
          console.log(`[OPEN CLOSE MODAL] User ${interaction.user.id} is not staff`);
          return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });
        }
        
        // Check if selections were made
        if (!ticket._closeFlowTemp) {
          console.log(`[OPEN CLOSE MODAL] No temp data found for ticket ${code}`);
          return interaction.reply({ content: 'Please make selections first before providing a reason.', ephemeral: true });
        }
        
        console.log(`[OPEN CLOSE MODAL] Temp data for ticket ${code}:`, JSON.stringify(ticket._closeFlowTemp));
        
        // Validate tutor teaches the selected subject
        const temp = ticket._closeFlowTemp;
        if (temp.hired === 'yes' && temp.hiredTutorId && temp.hiredTutorId !== 'none' && temp.assignedSubject) {
          const selectedSubject = temp.assignedSubject === 'ticket_subject' ? ticket.subject : temp.assignedSubject;
          const tutorSubjects = [];
          for (const [subj, tutors] of Object.entries(db.subjectTutors)) {
            if (tutors.includes(temp.hiredTutorId)) {
              tutorSubjects.push(subj);
            }
          }
          
          if (!tutorSubjects.includes(selectedSubject)) {
            return interaction.reply({ content: `Error: This tutor does not teach ${selectedSubject}. Please select a different tutor or subject.`, ephemeral: true });
          }
        }
        
        // Open modal for close reason
        const modal = new ModalBuilder()
          .setCustomId(`close_ticket_modal|${code}`)
          .setTitle(`Close Ticket ${code}`);
        
        const reasonInput = new TextInputBuilder()
          .setCustomId('close_reason')
          .setLabel('Reason for closing')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Enter the reason for closing this ticket...');
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        
        try {
          console.log(`[OPEN CLOSE MODAL] Attempting to show modal for ticket ${code}`);
          await interaction.showModal(modal);
          console.log(`[OPEN CLOSE MODAL] Modal shown successfully for ticket ${code}`);
        } catch (err) {
          console.error('[OPEN CLOSE MODAL] showModal failed', err);
          try { notifyStaffError(err, 'open_close_modal showModal', interaction); } catch (e) {}
          await interaction.reply({ content: 'Could not open modal, try again.', ephemeral: true });
        }
        return;
      }
    } // Close button block
    
    // MODAL SUBMITS and select menus handling etc
    if (interaction.isModalSubmit()) {
      console.log(`[MODAL SUBMIT] First block reached, customId: ${interaction.customId}`);
      // deny modal flow unchanged
      if (interaction.customId && interaction.customId.startsWith('deny_modal|')) {
        console.log(`[MODAL SUBMIT] First block - handling deny_modal`);
        // same code as original deny flow, but with notifyStaffError on catches
        const code = interaction.customId.split('|')[1];
        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true });
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can deny tickets.', ephemeral: true });

        if (ticket.approved) {
          try {
            if (!interaction.replied && !interaction.deferred) await interaction.deferReply({ ephemeral: true }).catch(() => {});
            await interaction.editReply({ content: `Ticket ${code} was approved meanwhile, deny cancelled.`, ephemeral: true });
          } catch (e) {
            try { await interaction.followUp({ content: `Ticket ${code} was approved meanwhile, deny cancelled.`, ephemeral: true }); } catch {}
          }
          return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const reason = interaction.fields.getTextInputValue('deny_reason') || '(no reason provided)';

        // build transcript using Discord timestamp format
        const lines = [];
        lines.push(`Transcript for ticket ${code}`);
        lines.push(`Subject: ${ticket.subject}`);
        lines.push(`Student ID: ${ticket.studentId}`);
        lines.push(`Denied by: ${interaction.user.tag}`);
        lines.push(`Reason: ${reason}`);
        lines.push('----------------------------------');
        for (const m of ticket.messages || []) {
          const when = `<t:${Math.floor(m.at / 1000)}:f>`;
          let row = `[${when}] ${m.who}: ${m.text || ''}`;
          if (m.attachments && m.attachments.length) row += `\nAttachments: ${m.attachments.join(' ')}`;
          lines.push(row);
        }
        lines.push('----------------------------------\nEnd of transcript');

        // post transcript
        try {
          const transcriptsChannel = await interaction.guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null);
          if (transcriptsChannel) {
            const fullTranscript = lines.join('\n');
            const chunks = splitMessage(fullTranscript, 2000);
            
            // Send transcript in chunks
            for (let i = 0; i < chunks.length; i++) {
              await transcriptsChannel.send(chunks[i]).catch((err) => {
                console.warn('Failed to send transcript chunk', err);
              });
              // Small delay between chunks to avoid rate limiting (only if not last chunk)
              if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
            
            // Send attachments separately
            for (const m of ticket.messages || []) {
              if (m.attachments && m.attachments.length) {
                for (const url of m.attachments) {
                  try { await transcriptsChannel.send({ content: url }).catch(() => {}); } catch (e) {}
                }
              }
            }
          } else console.warn('Transcripts channel not found');
        } catch (e) { console.warn('posting transcript failed', e); try { notifyStaffError(e, 'deny_modal post transcript', interaction); } catch (err) {} }

        // DM student
        try {
          const studentUser = await client.users.fetch(ticket.studentId).catch(() => null);
          if (studentUser) {
            const dmText = `Your enquiry (${code}) about ${ticket.subject} was denied by staff.\nReason: ${reason}\nIf you think this was a mistake, please open a new enquiry with more details.`;
            await studentUser.send(dmText).catch(() => { console.warn('could not DM student'); });
          }
        } catch (e) { console.warn('DM student failed', e); try { notifyStaffError(e, 'deny_modal DM student', interaction); } catch (err) {} }

        // Delete or hide channel
        try {
          const guild = interaction.guild;
          const ticketChannel = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
          if (ticketChannel) {
            await ticketChannel.send('Ticket denied by staff, closing now.').catch(() => {});
            await ticketChannel.delete('Denied by staff, transcript saved').catch(async (err) => {
              console.warn('delete failed, trying hide:', err);
              try { await ticketChannel.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (e) { console.warn('hide also failed', e); }
            });
          }
        } catch (e) { console.warn('ticket channel deletion/hide failed', e); try { notifyStaffError(e, 'deny_modal channel finalize', interaction); } catch (err) {} }

        // Archive tutors thread
        try {
          if (ticket.tutorThreadId) {
            const thread = await interaction.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
            if (thread && thread.isThread()) {
              await thread.send({ content: `Enquiry ${code} was denied by ${interaction.user.tag}` }).catch(() => {});
              await thread.setArchived(true).catch(() => {});
            }
          }
        } catch (e) { console.warn('archive thread failed', e); try { notifyStaffError(e, 'deny_modal archive thread', interaction); } catch (err) {} }

        delete db.tickets[code];
        saveDB();

        try {
          await interaction.editReply({ content: `Ticket ${code} denied and transcript saved, student notified.` });
        } catch (e) {
          try { await interaction.followUp({ content: `Ticket ${code} denied and transcript saved, student notified.`, ephemeral: true }); } catch {}
        }
        return;
      }
      // If it's not a deny_modal, continue to check other modal handlers below
    }

    // MODAL SUBMITS and select menus handling etc
    if (interaction.isModalSubmit()){
      console.log(`[MODAL SUBMIT] Second block reached, customId: ${interaction.customId}, type: ${interaction.type}`);
      // Leave a review modal handler
      if (interaction.customId && interaction.customId.startsWith('review_modal|')) {
          const [, studentId, tutorId] = interaction.customId.split('|');
          
          // Verify the user is the student
          if (interaction.user.id !== studentId) {
              return interaction.reply({ content: 'Only the student can submit this review.', ephemeral: true });
          }
          
          const rating = parseInt(interaction.fields.getTextInputValue('review_rating'));
          const text = interaction.fields.getTextInputValue('review_text');
          
          // Validate rating
          if (isNaN(rating) || rating < 1 || rating > 5) {
              return interaction.reply({ content: 'Rating must be a number between 1 and 5.', ephemeral: true });
          }
          
          // Create pending review
          const review = {
              id: Date.now().toString(),
              studentId,
              tutorId,
              subject: db.studentAssignments[studentId]?.subject || 'Unknown',
              rating,
              text,
              submittedAt: Date.now(),
              approved: false
          };
          
          db.pendingReviews.push(review);
          saveDB();
          
          // Notify staff
          try {
              const staffChannel = await interaction.guild?.channels.fetch(STAFF_CHAT_ID).catch(() => null) || 
                                   await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
              if (staffChannel) {
                  const embed = new EmbedBuilder()
                      .setTitle('New Review Submitted')
                      .setDescription(`Student <@${studentId}> submitted a review for tutor <@${tutorId}>`)
                      .addFields(
                          { name: 'Rating', value: `${'⭐'.repeat(rating)} (${rating}/5)`, inline: true },
                          { name: 'Subject', value: review.subject, inline: true },
                          { name: 'Review', value: text.substring(0, 500) + (text.length > 500 ? '...' : '') }
                      )
                      .setTimestamp();
                  
                  // Add approve/deny buttons
                  // In the review_modal submit handler, update the staff notification embed:

                  // Create buttons for staff
                  const row = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                          .setCustomId(`approve_review|${review.id}`)
                          .setLabel('Approve')
                          .setStyle(ButtonStyle.Success),
                      new ButtonBuilder()
                          .setCustomId(`deny_review|${review.id}`)
                          .setLabel('Deny')
                          .setStyle(ButtonStyle.Danger),
                      new ButtonBuilder()
                          .setCustomId(`redact_review|${review.id}`)
                          .setLabel('Redact Text')
                          .setStyle(ButtonStyle.Secondary)
                  );

                  await staffChannel.send({ embeds: [embed], components: [row] });
              }
          } catch (e) {
              console.warn('Failed to notify staff about review', e);
          }
          
          return interaction.reply({ content: 'Review submitted! It will be reviewed by staff.', ephemeral: true });
      }

            // redact review modal handler - auto-approve after redaction
              if (interaction.customId && interaction.customId.startsWith('redact_review_modal|')) {
                  const reviewId = interaction.customId.split('|')[1];
                  const reviewIndex = db.pendingReviews.findIndex(r => r.id === reviewId);
                  const review = db.pendingReviews[reviewIndex];
                  
                  if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true });
                  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can redact reviews.', ephemeral: true });
                  
                  const redactedText = interaction.fields.getTextInputValue('redacted_text');
                  review.text = redactedText;
                  review.redacted = true;
                  
                  // Remove from pending and add to tutor's profile
                  db.pendingReviews.splice(reviewIndex, 1);
                  
                  const tutorProfile = db.tutorProfiles[review.tutorId] || { reviews: [], rating: { count: 0, avg: 0 } };
                  if (!tutorProfile.reviews) tutorProfile.reviews = [];
                  if (!tutorProfile.rating) tutorProfile.rating = { count: 0, avg: 0 };
                  
                  tutorProfile.reviews.push(review);
                  
                  // Update rating
                  const oldCount = tutorProfile.rating.count;
                  const oldAvg = tutorProfile.rating.avg;
                  const newCount = oldCount + 1;
                  const newAvg = ((oldAvg * oldCount) + review.rating) / newCount;
                  
                  tutorProfile.rating = { count: newCount, avg: newAvg };
                  db.tutorProfiles[review.tutorId] = tutorProfile;
                  saveDB();
                  
                  // Update review threads for this tutor
                  try {
                      await updateReviewThreadsForTutor(review.tutorId);
                  } catch (e) {
                      console.warn('Failed to update review threads', e);
                  }
                  
                  // Notify tutor
                  try {
                      const tutorUser = await client.users.fetch(review.tutorId).catch(() => null);
                      if (tutorUser) {
                          await tutorUser.send(`A student left you a ${'⭐'.repeat(review.rating)} star review! (Staff redacted for privacy)\n"${review.text.substring(0, 500)}"`);
                      }
                  } catch (e) { console.warn('Failed to DM tutor about redacted review', e); }
                  
                  // Update the original message
                  try {
                      await interaction.message.edit({ 
                          content: '✅ Review redacted and approved.',
                          embeds: [],
                          components: [] 
                      }).catch(() => {});
                  } catch (e) {}
                  
                  return interaction.reply({ content: 'Review text has been redacted and auto-approved.', ephemeral: true });
              }

      // createad modal submit
        if (interaction.customId && interaction.customId.startsWith('createad_modal|')) {
          const parts = interaction.customId.split('|');
          const interactionId = parts[1];
          const levelKey = normalizeCreateAdLevelKey(parts[2]) || 'other';
          const origin = parts[3] || null;
          const originChannel = parts[4] || null;
          const subjectKeyFromModal = parts[5] || null;
            
            if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can create ads.', ephemeral: true });

            // Defer reply immediately to prevent interaction timeout
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            // Get subject from select menu in modal
            let subject = '';
            try {
                const subjectValues = interaction.fields.getStringSelectValues('ad_subject');
                subject = subjectValues[0];
            } catch (e) {
                return interaction.editReply({ content: 'Subject selection is required.' });
            }
            
            // Get tutor from select menu in modal
            let selectedTutorId = null;
            try {
                const tutorValues = interaction.fields.getStringSelectValues('ad_tutor');
                const tutorValue = tutorValues[0];
                if (tutorValue && tutorValue !== 'none') {
                    selectedTutorId = tutorValue;
                }
            } catch (e) { /* optional field may not exist */ }

            // Get all template fields (parsed from combined inputs)
            const subjectDetails = interaction.fields.getTextInputValue('ad_subject_details') || '';
            const tutorDetails = interaction.fields.getTextInputValue('ad_tutor_details') || '';
            const optionalFields = interaction.fields.getTextInputValue('ad_optional_fields') || '';
            
            // Parse subject details
            let subjectLevel = '';
            let subjectCodes = '';
            if (subjectDetails) {
                const levelMatch = subjectDetails.match(/Subject Level:\s*(.+?)(?:\n|$)/i);
                const codesMatch = subjectDetails.match(/Subject codes?:\s*(.+?)(?:\n|$)/i);
                subjectLevel = levelMatch ? levelMatch[1].trim() : '';
                subjectCodes = codesMatch ? codesMatch[1].trim() : '';
            }
            
            // Parse tutor details
            let languages = '';
            let classType = '';
            let classDuration = '';
            let monthlySchedule = '';
            let price = '';
            let timezone = '';
            if (tutorDetails) {
              const langMatch = tutorDetails.match(/Languages?:\s*(.+?)(?:\n|$)/i);
              const typeMatch = tutorDetails.match(/Class Type:\s*(.+?)(?:\n|$)/i);
              const durationMatch = tutorDetails.match(/Class Duration:\s*(.+?)(?:\n|$)/i);
              const weekMatch = tutorDetails.match(/Classes(?:\/| per )week:\s*(.+?)(?:\n|$)/i);
              const monthMatch = tutorDetails.match(/Classes(?:\/| per )month:\s*(.+?)(?:\n|$)/i);
              const priceMatch = tutorDetails.match(/Price per Class.*?:\s*(.+?)(?:\n|$)/i);
              const tzMatch = tutorDetails.match(/Time zone:\s*(.+?)(?:\n|$)/i);
              languages = langMatch ? langMatch[1].trim() : '';
              classType = typeMatch ? typeMatch[1].trim() : '';
              classDuration = durationMatch ? durationMatch[1].trim() : '';
              const classesWeek = weekMatch ? weekMatch[1].trim() : '';
              const classesMonth = monthMatch ? monthMatch[1].trim() : '';
              if (classesWeek && classesMonth) {
                monthlySchedule = `${classesWeek} classes/week = ${classesMonth} classes/month`;
              } else if (classesWeek) {
                monthlySchedule = `${classesWeek} classes/week`;
              } else if (classesMonth) {
                monthlySchedule = `${classesMonth} classes/month`;
              } else {
                const scheduleMatch = tutorDetails.match(/Monthly Schedule:\s*(.+?)(?:\n|$)/i);
                monthlySchedule = scheduleMatch ? scheduleMatch[1].trim() : '';
              }
              price = priceMatch ? priceMatch[1].trim() : '';
              timezone = tzMatch ? tzMatch[1].trim() : '';
            }
            
            // Parse optional fields (Tutor Message, Testimonials, Payment Terms, Color, Role)
            let tutorMessage = '';
            let testimonials = '';
            let paymentTerms = '100% upfront before classes begin';
            let colorVal = null;
            let roleMention = null;
            
            if (optionalFields) {
                // Parse tutor message
                const tutorMsgMatch = optionalFields.match(/Message from tutor:\s*(.+?)(?:\n|Student|Payment|Color|Role|$)/is);
                if (tutorMsgMatch) tutorMessage = tutorMsgMatch[1].trim();
                
                // Parse testimonials
                const testMatch = optionalFields.match(/Student Testimonials?:\s*(.+?)(?:\n|Payment|Color|Role|$)/is);
                if (testMatch) testimonials = testMatch[1].trim();
                
                // Parse payment terms
                const paymentMatch = optionalFields.match(/Payment Terms?:\s*(.+?)(?:\n|Color|Role|$)/is);
                if (paymentMatch) paymentTerms = paymentMatch[1].trim();
                
                // Parse color
                const colorMatch = optionalFields.match(/Color:\s*(#?[0-9a-fA-F]{6})/i);
                if (colorMatch) {
                    const raw = colorMatch[1].trim();
                    if (/^#?[0-9a-fA-F]{6}$/.test(raw)) colorVal = raw.startsWith('#') ? raw : `#${raw}`;
                }
                
                // Parse role
                const roleMatch = optionalFields.match(/Role(?: ID)?:\s*(\d+)/i);
                if (roleMatch) {
                    const roleId = roleMatch[1].trim();
                    if (/^\d+$/.test(roleId)) roleMention = `<@&${roleId}>`;
                }
            }

            // Build concise message for main embed (subject shown as embed title)
            let message = '';
            message += `**Level:** ${subjectLevel}\n`;
            message += `**Price:** $${price}\n`;
            message += `**Timezone:** ${timezone}\n`;
            message += `**Languages:** ${languages}\n\n`;
            message += `Click "View Full Details" below for more information, or "Talk to Tutors!" to start a conversation.`;

            // Generate a unique ad code (e.g. IG-1, AL-3) for this ad
            const adCode = generateAdCode(levelKey);

            // Store full details for ephemeral message
            const fullDetailsMessage = {
              subjectLevel,
              subjectCodes,
              languages,
              classType,
              classDuration,
              monthlySchedule,
              price,
              timezone,
              tutorMessage,
              testimonials,
              paymentTerms
            };

            const embed = new EmbedBuilder().setTitle(subject).setDescription(message).setTimestamp().setFooter({ text: `Ad Code: ${adCode}` });
            if (colorVal) embed.setColor(colorVal);
            else if (db.defaultEmbedColor) {
                try { embed.setColor(db.defaultEmbedColor); } catch (e) {}
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`view_full_details|${subject}`).setLabel('View Full Details').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`ad_enquire|${subject}`).setLabel('Talk to Tutors!').setStyle(ButtonStyle.Success)
            );

            const findCh = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
            if (!findCh) return interaction.editReply({ content: 'Find-a-tutor channel not found.' });

            const messageContent = roleMention || undefined;
            const sent = await findCh.send({ content: messageContent, embeds: [embed], components: [row] }).catch(err => { 
                console.error('send createad failed', err); 
                try { notifyStaffError(err, 'createad send', interaction); } catch (e) {} 
                return null; 
            });
            
            // Also post to the discovered subject channel within the matching category
            let categorySent = null;
            let categoryCh = null;
            try {
                categoryCh = await findSubjectChannel(interaction.guild, levelKey, subject);
                if (categoryCh) {
                    categorySent = await categoryCh.send({ content: messageContent, embeds: [embed], components: [row] }).catch(() => null);
                }
            } catch (e) {
                console.warn('createad category post failed', e);
                try { notifyStaffError(e, 'createad category post', interaction); } catch (err) {}
            }
            
            if (sent) {
                if (!db.createAds) db.createAds = {};
                db.createAds[sent.id] = { 
                    channelId: findCh.id, 
                    embed: { title: subject, description: message, color: colorVal || db.defaultEmbedColor },
                    tutorId: selectedTutorId,
                    level: levelKey,
                    adCode,
                    categoryChannelId: categoryCh ? categoryCh.id : null,
                    categoryMessageId: categorySent ? categorySent.id : null,
                    fullDetails: fullDetailsMessage
                };
                saveDB();

                // Create review thread if a tutor was selected and has reviews
                if (selectedTutorId) {
                    try {
                        const tutorProfile = db.tutorProfiles[selectedTutorId];
                        if (tutorProfile && tutorProfile.reviews && tutorProfile.reviews.length > 0) {
                            // Create a thread for reviews
                            const threadName = `Reviews for ${subject} Tutor`;
                            const thread = await sent.startThread({ 
                                name: threadName.substring(0, 100), 
                                autoArchiveDuration: 1440,
                                reason: 'Tutor reviews'
                            }).catch(() => null);
                            
                            if (thread) {
                              // Store thread ID in createAds
                              if (!db.createAds[sent.id]) db.createAds[sent.id] = {};
                              db.createAds[sent.id].reviewThreadId = thread.id;
                              saveDB();
                              
                              // Post initial reviews embed with pagination
                              try {
                                const messageData = await sendReviewPage(selectedTutorId, 0, 'newest');
                                if (messageData) await thread.send(messageData).catch(() => {});
                              } catch (e) {
                                console.warn('Failed to post reviews to thread', e);
                              }
                            }
                        }
                    } catch (e) {
                        console.warn('Failed to create review thread', e);
                    }
                }
            }

            // If this createad was opened from modmail, close the originating ticket channel
            try {
              if (origin === 'modmail' && originChannel && db._modmail_helpers && typeof db._modmail_helpers.closeTicketByChannel === 'function') {
                await db._modmail_helpers.closeTicketByChannel(originChannel, `${interaction.user.tag} (createad)`);
              }
            } catch (e) { console.warn('Failed to close originating modmail ticket after createad', e); }

            // Trigger sticky repost in find channel so sticky is always fresh after createad
            try {
                await repostStickyInChannel(findCh);
            } catch (e) {
                console.warn('sticky repost after createad failed', e);
                try { notifyStaffError(e, 'repostSticky after createad', interaction); } catch (err) {}
            }

            const levelLabel = CREATEAD_LEVEL_LABELS[levelKey] || 'Other';
            return interaction.editReply({ content: categorySent ? `Ad posted in find-a-tutor and **${levelLabel}**.` : `Ad posted in find-a-tutor. (Could not post in **${levelLabel}** category channel.)` });
        }

      // editad modal submit
      if (interaction.customId && interaction.customId.startsWith('editad_modal|')) {
        const parts = interaction.customId.split('|');
        const messageId = parts[1];
        const source = parts[2] || 'find'; // 'find' or 'category'
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit ads.', ephemeral: true });
        
        // Defer reply immediately to prevent interaction timeout
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        
        const messageText = interaction.fields.getTextInputValue('edit_ad_message') || '';
        
        // Get subject from select menu in modal
        let subject = '';
        try {
            const subjectValues = interaction.fields.getStringSelectValues('edit_ad_subject');
            subject = subjectValues[0];
        } catch (e) {
            return interaction.editReply({ content: 'Subject selection is required.' });
        }

        // Find the ad data to get the paired message IDs
        let adData = null;
        let findMessageId = null;
        let categoryMessageId = null;
        
        if (source === 'find') {
          findMessageId = messageId;
          // Get ad data from find message
          adData = db.createAds[messageId];
          if (adData && adData.categoryMessageId) {
            categoryMessageId = adData.categoryMessageId;
          }
        } else {
          categoryMessageId = messageId;
          // Find ad data by categoryMessageId
          for (const [msgId, data] of Object.entries(db.createAds || {})) {
            if (data.categoryMessageId === messageId) {
              adData = data;
              findMessageId = msgId;
              break;
            }
          }
        }

        // Get both channels
        const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
        let categoryChannel = null;
        if (adData && adData.categoryChannelId) {
          categoryChannel = await interaction.guild.channels.fetch(adData.categoryChannelId).catch(() => null);
        }
        
        if (!findChannel && !categoryChannel) return interaction.editReply({ content: 'Could not find channels to update.' });

        // Get optional color
        let colorVal = null;
        try {
            const raw = interaction.fields.getTextInputValue('edit_ad_color') || '';
            const cleaned = raw.trim();
            if (cleaned && /^#?[0-9a-fA-F]{6}$/.test(cleaned)) {
                colorVal = cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
            } else {
                colorVal = adData?.embed?.color || db.defaultEmbedColor || null;
            }
        } catch (e) {
            colorVal = adData?.embed?.color || db.defaultEmbedColor || null;
        }

        // Get optional role mention
        let roleMention = null;
        try {
            const roleIdRaw = interaction.fields.getTextInputValue('edit_ad_role_mention') || '';
            const roleId = roleIdRaw.trim();
            if (roleId && /^\d+$/.test(roleId)) {
                roleMention = `<@&${roleId}>`;
            }
        } catch (e) { /* optional field may not exist */ }

        const embed = new EmbedBuilder().setTitle(subject).setDescription(messageText).setTimestamp();
        if (colorVal) {
          try { embed.setColor(String(colorVal)); } catch (e) {}
        }

        const messageContent = roleMention || undefined;

        // Update find-a-tutor message if it exists
        let findUpdateSuccess = false;
        if (findChannel && findMessageId) {
          try {
            const findMsg = await findChannel.messages.fetch(findMessageId).catch(() => null);
            if (findMsg) {
              await findMsg.edit({ content: messageContent, embeds: [embed] }).catch(err => { console.error('edit ad in find channel failed', err); throw err; });
              findUpdateSuccess = true;
            }
          } catch (e) {
            console.warn('Failed to update find-a-tutor message', e);
          }
        }
        
        // Update category message if it exists
        let categoryUpdateSuccess = false;
        if (categoryChannel && categoryMessageId) {
          try {
            const categoryMsg = await categoryChannel.messages.fetch(categoryMessageId).catch(() => null);
            if (categoryMsg) {
              await categoryMsg.edit({ content: messageContent, embeds: [embed] }).catch(err => { console.error('edit ad in category channel failed', err); throw err; });
              categoryUpdateSuccess = true;
            }
          } catch (e) {
            console.warn('Failed to update category message', e);
          }
        }
        
        // Update database
        if (findMessageId && adData) {
          db.createAds[findMessageId] = { 
            ...adData,
            embed: { title: subject, description: messageText, color: colorVal } 
          };
          saveDB();
        }
        
        let resultMsg = 'Ad updated';
        if (findUpdateSuccess && categoryUpdateSuccess) {
          resultMsg = 'Ad updated in both find-a-tutor and category channel.';
        } else if (findUpdateSuccess) {
          resultMsg = 'Ad updated in find-a-tutor. (Category channel update failed)';
        } else if (categoryUpdateSuccess) {
          resultMsg = 'Ad updated in category channel. (Find-a-tutor update failed)';
        } else {
          resultMsg = 'Failed to update ad in any channel.';
        }
        
        return interaction.editReply({ content: resultMsg });
      }

      // sticky modal submit
      if (interaction.customId === 'sticky_modal') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set sticky.', ephemeral: true });
        const title = interaction.fields.getTextInputValue('sticky_title') || '';
        const body = interaction.fields.getTextInputValue('sticky_body') || '';
        const color = db.defaultEmbedColor || null;

        const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
        if (!findChannel) return interaction.reply({ content: 'Find channel not found', ephemeral: true });

        // remove previous sticky if exists and post new one via helper
        db.sticky = { title, body, color, messageId: db.sticky?.messageId || null };
        saveDB();
        try {
          await repostStickyInChannel(findChannel);
        } catch (e) {
          console.warn('post sticky failed', e);
          try { notifyStaffError(e, 'sticky_modal repost', interaction); } catch (err) {}
        }
        return interaction.reply({ content: 'Sticky updated.', ephemeral: true });
      }

      // editinit modal submit
      if (interaction.customId === 'editinit_modal') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit init message.', ephemeral: true });
        const newInit = interaction.fields.getTextInputValue('init_message') || '';
        db.initMessage = newInit;
        saveDB();
        return interaction.reply({ content: 'Initial ticket message updated.', ephemeral: true });
      }

      // tutor_notes_modal|USERID -> staff editing notes for a tutor
      if (interaction.customId && interaction.customId.startsWith('tutor_notes_modal|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit tutor notes.', ephemeral: true });
        const userid = interaction.customId.split('|')[1];
        const notes = interaction.fields.getTextInputValue('tutor_notes') || '';
        
        db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        db.tutorProfiles[userid].notes = notes;
        saveDB();
        
        return interaction.reply({ content: `Notes updated for tutor ${userid}.`, ephemeral: true });
      }

      // close_ticket_modal|CODE -> staff provided reason, plus fields were stored temporarily on ticket._closeFlowTemp
      if (interaction.customId && interaction.customId.startsWith('close_ticket_modal|')) {
        console.log(`[CLOSE MODAL SUBMIT] Handler reached! customId: ${interaction.customId}`);
        console.log(`[CLOSE MODAL SUBMIT] Interaction type: ${interaction.type}, isModalSubmit: ${interaction.isModalSubmit()}`);
        
        // Wrap entire handler in try-catch to catch any unhandled errors
        try {
          console.log(`[CLOSE MODAL SUBMIT] Attempting to defer reply...`);
          // Defer reply immediately to acknowledge the modal (must be first!)
          await interaction.deferReply({ ephemeral: true });
          console.log(`[CLOSE MODAL SUBMIT] Successfully deferred reply`);
        } catch (deferErr) {
          console.error('Failed to defer close modal reply', deferErr);
          try { await notifyStaffError(deferErr, 'close_ticket_modal deferReply', interaction); } catch (e) {}
          // If defer fails, try to reply (but this might also fail)
          try { 
            await interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }); 
          } catch (replyErr) {
            console.error('Failed to reply after defer failed', replyErr);
          }
          return;
        }
        
        try {
          const code = interaction.customId.split('|')[1];
          console.log(`[CLOSE MODAL SUBMIT] Extracted code: ${code}`);
          const ticket = db.tickets[code];
          if (!ticket) {
            console.log(`[CLOSE MODAL SUBMIT] Ticket ${code} not found in database`);
            try { await interaction.followUp({ content: 'Ticket not found.', ephemeral: true }); } catch (e) {
              console.error('Failed to followUp for missing ticket', e);
            }
            return;
          }
          console.log(`[CLOSE MODAL SUBMIT] Ticket ${code} found`);
          if (!isStaff(interaction.member)) {
            console.log(`[CLOSE MODAL SUBMIT] User ${interaction.user.id} is not staff`);
            try { await interaction.followUp({ content: 'Only staff can close tickets.', ephemeral: true }); } catch (e) {
              console.error('Failed to followUp for non-staff', e);
            }
            return;
          }

          let reason = '(no reason provided)';
          try {
            if (interaction.fields && typeof interaction.fields.getTextInputValue === 'function') {
              reason = interaction.fields.getTextInputValue('close_reason') || '(no reason provided)';
              console.log(`[CLOSE MODAL SUBMIT] Got reason: ${reason.substring(0, 50)}...`);
            } else {
              console.error('[CLOSE MODAL SUBMIT] interaction.fields or getTextInputValue not available');
              try { await notifyStaffError(new Error('interaction.fields not available'), 'close_ticket_modal fields check', interaction); } catch (e) {}
            }
          } catch (fieldErr) {
            console.error('[CLOSE MODAL SUBMIT] Failed to get close_reason field', fieldErr);
            try { await notifyStaffError(fieldErr, 'close_ticket_modal getTextInputValue', interaction); } catch (e) {}
          }
          
          // retrieve temp selections stored on ticket (set when staff picked selection menu)
          const temp = ticket._closeFlowTemp || {};
          console.log(`[CLOSE MODAL SUBMIT] Temp data for ticket ${code}:`, JSON.stringify(temp));
          // Capture hired flag, tutorId chosen, subjectChosen
          const hired = temp.hired === 'yes';
          const hiredTutorId = temp.hiredTutorId || null;
          let assignedSubject = temp.assignedSubject || ticket.subject || null;
          
          // Handle default subject selection
          if (assignedSubject === 'ticket_subject') {
            assignedSubject = ticket.subject;
          }

          // Proceed to close similar to old /close but include assignment if hired
          try {
          if (!interaction.guild) {
            try { await interaction.followUp({ content: 'Error: This command must be used in a server.', ephemeral: true }); } catch (e) {}
            return;
          }
          
          // Send success message immediately (before heavy work)
          let successSent = false;
          try {
            await interaction.followUp({ content: `Ticket ${code} closed.`, ephemeral: true });
            successSent = true;
          } catch (followErr) {
            console.error('Failed to send success message', followErr);
            // Continue with closing even if message fails
          }
          
          // archive tutors thread
          try {
            if (ticket.tutorThreadId) {
              const thread = await interaction.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
              if (thread && thread.isThread()) {
                await thread.send({ content: `Enquiry ${code} was closed by ${interaction.user.tag}` }).catch(() => {});
                await thread.setArchived(true).catch(() => {});
              }
            }
          } catch (e) { console.warn('archive thread failed', e); try { notifyStaffError(e, 'close archive', interaction); } catch (err) {} }

          // transcript
          const lines = [];
          lines.push(`Transcript for ticket ${code}`);
          lines.push(`Subject: ${ticket.subject}`);
          lines.push(`Student ID: ${ticket.studentId}`);
          lines.push(`Closed by: ${interaction.user.tag}`);
          lines.push(`Reason: ${reason}`);
          if (hired && hiredTutorId) {
            let tutorName = hiredTutorId;
            try {
              const member = await interaction.guild.members.fetch(hiredTutorId).catch(() => null);
              if (member) tutorName = member.user.tag;
            } catch (e) {}
            lines.push(`Assigned tutor: ${tutorName}, subject: ${assignedSubject}`);
          }
          lines.push('----------------------------------');
          for (const m of ticket.messages || []) {
            const when = `<t:${Math.floor(m.at / 1000)}:f>`;
            let row = `[${when}] ${m.who}: ${m.text || ''}`;
            if (m.attachments && m.attachments.length) row += `\nAttachments: ${m.attachments.join(' ')}`;
            lines.push(row);
          }
          lines.push('----------------------------------\nEnd of transcript');

          try {
            const transcriptsChannel = await interaction.guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null);
            if (transcriptsChannel) {
              const fullTranscript = lines.join('\n');
              const chunks = splitMessage(fullTranscript, 2000);
              
              // Send transcript in chunks
              for (let i = 0; i < chunks.length; i++) {
                await transcriptsChannel.send(chunks[i]).catch((err) => {
                  console.warn('Failed to send transcript chunk', err);
                });
                // Small delay between chunks to avoid rate limiting (only if not last chunk)
                if (i < chunks.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              }
              
              // Send attachments separately
              for (const m of ticket.messages || []) {
                if (m.attachments && m.attachments.length) {
                  for (const url of m.attachments) {
                    try { await transcriptsChannel.send({ content: url }).catch(() => {}); } catch (e) {}
                  }
                }
              }
            }
          } catch (e) { console.warn('send transcript failed', e); try { notifyStaffError(e, 'close send transcript', interaction); } catch (err) {} }

          // DM student notification
          try {
            const studentUser = await client.users.fetch(ticket.studentId).catch(() => null);
            if (studentUser) {
              let dmText = `Your enquiry (${code}) about ${ticket.subject} was closed by staff.\nReason: ${reason}`;
              if (hired && hiredTutorId) {
                let tutorName = hiredTutorId;
                try {
                  const member = await interaction.guild.members.fetch(hiredTutorId).catch(() => null);
                  if (member) tutorName = member.user.tag;
                } catch (e) {}
                dmText += `\nYou were assigned to tutor ${tutorName} for ${assignedSubject}.`;
              }
              dmText += `\nTranscript saved.`;
              await studentUser.send(dmText).catch(() => { console.warn('could not DM student'); });
            }
          } catch (e) { console.warn('DM failed', e); try { notifyStaffError(e, 'close DM student', interaction); } catch (err) {} }

          // channel deletion or hide
          try {
            const ticketChannel = await interaction.guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
            if (ticketChannel) {
              await ticketChannel.send('Ticket closed by staff, deleting channel now.').catch(() => {});
              await ticketChannel.delete('Ticket closed by staff').catch(async (err) => {
                console.warn('delete failed, try hide', err);
                try { await ticketChannel.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (e) { console.warn('hide failed', e); }
              });
            }
          } catch (e) { console.warn('channel finalize failed', e); try { notifyStaffError(e, 'close finalize channel', interaction); } catch (err) {} }

          // assign student to tutor if hired
          if (hired && hiredTutorId) {
            try {
              // store assignment
              const now = Date.now();
              db.studentAssignments[ticket.studentId] = { tutorId: hiredTutorId, subject: assignedSubject, assignedAt: now, reviewScheduledAt: now + (db.reviewConfig.delaySeconds || 1296000) * 1000 };
              db.tutorProfiles[hiredTutorId] = db.tutorProfiles[hiredTutorId] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
              if (!db.tutorProfiles[hiredTutorId].students) db.tutorProfiles[hiredTutorId].students = [];
              if (!db.tutorProfiles[hiredTutorId].students.includes(ticket.studentId)) db.tutorProfiles[hiredTutorId].students.push(ticket.studentId);
              saveDB();
            } catch (e) {
              console.warn('failed to assign student to tutor', e);
              try { notifyStaffError(e, 'close assign student', interaction); } catch (err) {}
            }
          }

          // cleanup - clean up temp data before deleting ticket
          if (ticket._closeFlowTemp) {
            delete ticket._closeFlowTemp;
          }
          delete db.tickets[code];
          saveDB();
          
          // Success message was already sent at the beginning, no need to send again
        } catch (e) {
          console.error('close flow failed', e);
          try { 
            await notifyStaffError(e, 'close flow modal', interaction); 
          } catch (err) {
            console.error('Failed to notify staff about close error', err);
          }
          try { 
            await interaction.followUp({ content: 'Failed to close ticket, staff notified.', ephemeral: true }); 
          } catch (followErr) {
            console.error('Failed to followUp error message', followErr);
          }
        }
        } catch (outerErr) {
          // Catch any errors that occur outside the inner try-catch
          console.error('Outer error in close_ticket_modal handler', outerErr);
          try { 
            await notifyStaffError(outerErr, 'close_ticket_modal outer catch', interaction); 
          } catch (err) {
            console.error('Failed to notify staff about outer error', err);
          }
          try { 
            await interaction.followUp({ content: 'An unexpected error occurred. Staff have been notified.', ephemeral: true }); 
          } catch (followErr) {
            console.error('Failed to followUp in outer catch', followErr);
          }
        }
        return;
      }
    }

    // Select menus and other interaction types
    if (interaction.isStringSelectMenu()) {
      // CreateAd level/category select (before opening the modal)
      // customId: createad_level|<requesterUserId>
      if (interaction.customId && interaction.customId.startsWith('createad_level|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });
        const parts = interaction.customId.split('|');
        const requester = parts[1];
        if (String(interaction.user.id) !== String(requester) && !isStaff(interaction.member)) {
          return interaction.reply({ content: 'Only the command invoker or staff may set the category.', ephemeral: true });
        }

        const chosenRaw = interaction.values && interaction.values[0];
        const levelKey = normalizeCreateAdLevelKey(chosenRaw);
        if (!levelKey) {
          return interaction.reply({ content: 'Invalid category selected.', ephemeral: true });
        }

        const levelLabel = CREATEAD_LEVEL_LABELS[levelKey] || 'Selected';
        const openButton = new ButtonBuilder()
          .setCustomId(`open_createad_modal|${requester}|${levelKey}`)
          .setLabel('Open Create Ad Modal')
          .setStyle(ButtonStyle.Primary);

        // Keep the select menu so staff can change their mind
        const levelOptions = [
          new StringSelectMenuOptionBuilder().setLabel('University').setValue('university'),
          new StringSelectMenuOptionBuilder().setLabel('A level').setValue('a_level'),
          new StringSelectMenuOptionBuilder().setLabel('IGCSE').setValue('igcse'),
          new StringSelectMenuOptionBuilder().setLabel('Below IGCSE').setValue('below_igcse'),
          new StringSelectMenuOptionBuilder().setLabel('Language').setValue('language'),
          new StringSelectMenuOptionBuilder().setLabel('Other').setValue('other')
        ].map(opt => {
          try { if (opt.data?.value === levelKey) opt.setDefault(true); } catch (e) {}
          return opt;
        });

        const levelSelect = new StringSelectMenuBuilder()
          .setCustomId(`createad_level|${requester}`)
          .setPlaceholder('Select subject level category')
          .addOptions(levelOptions)
          .setRequired(true);

        const rowSelect = new ActionRowBuilder().addComponents(levelSelect);
        const rowButton = new ActionRowBuilder().addComponents(openButton);

        try {
          await interaction.update({
            content: `Category selected: **${levelLabel}**. Now open the modal.`,
            components: [rowSelect, rowButton]
          });
        } catch (e) {
          try {
            await interaction.reply({ content: `Category selected: **${levelLabel}**. Now open the modal.`, components: [rowSelect, rowButton], ephemeral: true });
          } catch (err) {}
        }
        return;
      }

      // Tutor select handler for username-based flows (info / notes / remove)
      if (interaction.customId && interaction.customId.startsWith('tutor_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });
        const parts = interaction.customId.split('|');
        // customId formats:
        // tutor_select|info
        // tutor_select|notes
        // tutor_select|remove|<subject>
        const subAction = parts[1];
        const selected = interaction.values && interaction.values[0];
        if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true });

        if (subAction === 'info') {
          const userid = String(selected);
          const subjects = [];
          for (const s of db.subjects) {
            const arr = db.subjectTutors[s] || [];
            if (arr.includes(userid)) subjects.push(s);
          }
          const adCodesList = Object.values(db.createAds || {}).filter(a => a.tutorId === userid && a.adCode).map(a => a.adCode);
          const profile = db.tutorProfiles[userid] || { addedAt: null, students: [], reviews: [], rating: { count: 0, avg: 0 } };
          const addedAt = profile && profile.addedAt ? `<t:${Math.floor(profile.addedAt/1000)}:f>` : '(unknown)';
          let userTag = '(not in guild)';
          let joined = '(unknown)';
          try {
            const member = await interaction.guild.members.fetch(userid).catch(() => null);
            if (member) {
              userTag = member.user.tag;
              joined = member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime()/1000)}:f>` : '(unknown)';
            } else {
              const user = await client.users.fetch(userid).catch(() => null);
              if (user) userTag = user.tag;
            }
          } catch (e) {}

          const rating = profile.rating && profile.rating.count ? `${(Number(profile.rating.avg) || 0).toFixed(2)} ⭐️ (${profile.rating.count})` : '(no ratings)';
          const studentList = (profile.students && profile.students.length) ? profile.students.join(', ') : '(none)';
          const notes = profile.notes || '(no notes)';
          const lines = [
            `Tutor info for: ${userTag} (${userid})`,
            `Ad code(s): ${adCodesList.length ? adCodesList.join(', ') : '(none)'}`,
            `Guild joined: ${joined}`,
            `Tutor added at: ${addedAt}`,
            `Subjects: ${subjects.length ? subjects.join(', ') : '(none)'}`,
            `Assigned students: ${studentList}`,
            `Rating: ${rating}`,
            `Notes: ${notes}`
          ];
          try {
            await interaction.update({ content: lines.join('\n'), components: [] });
          } catch (e) {
            try { await interaction.reply({ content: lines.join('\n'), ephemeral: true }); } catch (err) { console.warn('tutor_select info reply failed', err); }
          }
          return;
        }

        if (subAction === 'notes') {
          const userid = String(selected);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          const currentNotes = db.tutorProfiles[userid].notes || '';
          const modal = new ModalBuilder()
            .setCustomId(`tutor_notes_modal|${userid}`)
            .setTitle(`Tutor Notes`);
          const notesInput = new TextInputBuilder()
            .setCustomId('tutor_notes')
            .setLabel('Notes for this tutor')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setValue(currentNotes.substring(0, 4000))
            .setPlaceholder('Enter notes about this tutor...')
            .setMaxLength(4000);
          modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
          try { await interaction.showModal(modal); } catch (err) { try { notifyStaffError(err, 'tutor_select showModal notes', interaction); } catch (e) {} return interaction.reply({ content: 'Could not open notes modal, try again.', ephemeral: true }); }
          return;
        }

        if (subAction === 'remove') {
          const subj = parts[2];
          if (!subj) return interaction.reply({ content: 'Subject not specified for removal.', ephemeral: true });
          const userid = String(selected);
          db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
          saveDB();
          try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_select revokeTutorAccess', interaction); } catch (err) {} }
          const tutorUser = await client.users.fetch(userid).catch(() => null);
          const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
          try {
            await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] });
          } catch (e) {
            try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_select remove reply failed', err); }
          }
          return;
        }
      }

      // Handler for /tutor add select flow: subject and tutor selection
      if (interaction.customId && interaction.customId.startsWith('tutor_add_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });
        const parts = interaction.customId.split('|');
        const which = parts[1];
        db._tempTutorAdd = db._tempTutorAdd || {};
        const key = interaction.user.id;
        db._tempTutorAdd[key] = db._tempTutorAdd[key] || { subject: null, userid: null };

        if (which === 'subject') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No subject selected.', ephemeral: true });
          db._tempTutorAdd[key].subject = selected;
          saveDB();
          // If userid already chosen, finalize
          if (db._tempTutorAdd[key].userid) {
            const userid = db._tempTutorAdd[key].userid;
            const subj = db._tempTutorAdd[key].subject;
            db.subjectTutors[subj] = db.subjectTutors[subj] || [];
            if (!db.subjectTutors[subj].includes(userid)) db.subjectTutors[subj].push(userid);
            db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
            saveDB();
            // Acknowledge interaction immediately to prevent expiration
            try {
              await interaction.deferUpdate();
            } catch (e) {
              // If deferUpdate fails, try update as fallback
              try {
                await interaction.update({ content: `Processing...`, components: [] });
              } catch (err) {
                // If both fail, interaction is likely already handled or expired
                return;
              }
            }
            try { await grantTutorAccess(userid); } catch (e) { try { notifyStaffError(e, 'tutor_add_select grantTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorAdd[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try {
              await interaction.editReply({ content: `Added tutor ${tutorDisplay} to ${subj}, access grant started.`, components: [] });
            } catch (e) {
              try { await interaction.followUp({ content: `Added tutor ${tutorDisplay} to ${subj}, access grant started.`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select subject reply failed', err); }
            }
            return;
          }
          try {
            await interaction.update({ content: `Subject ${selected} selected. Now choose a tutor to add (or run /tutor add again).`, components: interaction.message.components });
          } catch (e) {
            try { await interaction.reply({ content: `Subject ${selected} selected. Now choose a tutor to add (or run /tutor add again).`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select subject reply failed', err); }
          }
          return;
        }

        if (which === 'tutor') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true });
          db._tempTutorAdd[key].userid = String(selected);
          saveDB();
          if (db._tempTutorAdd[key].subject) {
            const userid = db._tempTutorAdd[key].userid;
            const subj = db._tempTutorAdd[key].subject;
            db.subjectTutors[subj] = db.subjectTutors[subj] || [];
            if (!db.subjectTutors[subj].includes(userid)) db.subjectTutors[subj].push(userid);
            db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
            saveDB();
            // Acknowledge interaction immediately to prevent expiration
            try {
              await interaction.deferUpdate();
            } catch (e) {
              // If deferUpdate fails, try update as fallback
              try {
                await interaction.update({ content: `Processing...`, components: [] });
              } catch (err) {
                // If both fail, interaction is likely already handled or expired
                return;
              }
            }
            try { await grantTutorAccess(userid); } catch (e) { try { notifyStaffError(e, 'tutor_add_select grantTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorAdd[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try {
              await interaction.editReply({ content: `Added tutor ${tutorDisplay} to ${subj}, access grant started.`, components: [] });
            } catch (e) {
              try { await interaction.followUp({ content: `Added tutor ${tutorDisplay} to ${subj}, access grant started.`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select tutor reply failed', err); }
            }
            return;
          }
          try {
            await interaction.update({ content: `Tutor ${selected} selected. Now choose a subject to add them to.`, components: interaction.message.components });
          } catch (e) {
            try { await interaction.reply({ content: `Tutor ${selected} selected. Now choose a subject to add them to.`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select tutor reply failed', err); }
          }
          return;
        }
      }
      // Handler for /tutor remove select flow: subject and tutor selection
      if (interaction.customId && interaction.customId.startsWith('tutor_remove_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });
        const parts = interaction.customId.split('|');
        const which = parts[1];
        db._tempTutorRemove = db._tempTutorRemove || {};
        const key = interaction.user.id;
        db._tempTutorRemove[key] = db._tempTutorRemove[key] || { subject: null, userid: null };

        if (which === 'subject') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No subject selected.', ephemeral: true });
          db._tempTutorRemove[key].subject = selected;
          saveDB();
          if (db._tempTutorRemove[key].userid) {
            const userid = db._tempTutorRemove[key].userid;
            const subj = db._tempTutorRemove[key].subject;
            db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
            saveDB();
            try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_remove_select revokeTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorRemove[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try { await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select subject reply failed', err); } }
            return;
          }
          try { await interaction.update({ content: `Subject ${selected} selected. Now choose a tutor to remove.`, components: interaction.message.components }); } catch (e) { try { await interaction.reply({ content: `Subject ${selected} selected. Now choose a tutor to remove.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select subject reply failed', err); } }
          return;
        }

        if (which === 'tutor') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true });
          db._tempTutorRemove[key].userid = String(selected);
          saveDB();
          if (db._tempTutorRemove[key].subject) {
            const userid = db._tempTutorRemove[key].userid;
            const subj = db._tempTutorRemove[key].subject;
            db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
            saveDB();
            try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_remove_select revokeTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorRemove[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try { await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select tutor reply failed', err); } }
            return;
          }
          try { await interaction.update({ content: `Tutor ${selected} selected. Now choose a subject to remove them from.`, components: interaction.message.components }); } catch (e) { try { await interaction.reply({ content: `Tutor ${selected} selected. Now choose a subject to remove them from.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select tutor reply failed', err); } }
          return;
        }
      }
      // Close-ticket select flow:
      // We show an ephemeral message with two selects and a button to open a modal for reason.
      // The staff will choose whether hired, optionally choose tutor, choose subject.
      // The selections are saved temporarily on the ticket object at ticket._closeFlowTemp

      // In the select menu section (around line 570-600), update the review_sort handler:
      if (interaction.customId && interaction.customId.startsWith('review_sort|')) {
        const [, tutorId, currentPage] = interaction.customId.split('|');
        const page = parseInt(currentPage) || 0;
        const sortMethod = interaction.values[0];

        try {
          const messageData = await sendReviewPage(tutorId, page, sortMethod);
          if (messageData) {
            await interaction.update(messageData);
          } else {
            await interaction.reply({ content: 'Failed to load reviews.', ephemeral: true });
          }
        } catch (error) {
          console.error('Failed to update review sort:', error);
          try { await notifyStaffError(error, 'review_sort handler', interaction); } catch (e) {}
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'Failed to update review list.', ephemeral: true });
            } else {
              await interaction.followUp({ content: 'Failed to update review list.', ephemeral: true });
            }
          } catch (e) {}
        }
        return;
      }

      if (interaction.customId && interaction.customId.startsWith('close_ticket_select|')) {
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true });

  const cmdParts = interaction.customId.split('|');
  const code = cmdParts[1];
  const which = cmdParts[2];
  const ticket = db.tickets[code];
  if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true });

  ticket._closeFlowTemp = ticket._closeFlowTemp || {};
  console.log(`[CLOSE SELECT] Ticket ${code}, which: ${which}, value: ${interaction.values[0]}`);
  
  if (which === 'hired') {
    ticket._closeFlowTemp.hired = interaction.values[0] || 'no';
    console.log(`[CLOSE SELECT] Saved hired selection: ${ticket._closeFlowTemp.hired} for ticket ${code}`);
    saveDB();
    console.log(`[CLOSE SELECT] Database saved after hired selection`);
    return interaction.update({ content: 'Selection saved. Now choose tutor and subject, then click "Provide reason and close".', components: interaction.message.components }).catch(() => {});
  } else if (which === 'tutor') {
  const selectedTutorId = interaction.values[0] || null;
  ticket._closeFlowTemp.hiredTutorId = selectedTutorId;
  console.log(`[CLOSE SELECT] Saved tutor selection: ${selectedTutorId} for ticket ${code}`);
  
  // Update subject dropdown to only show subjects this tutor teaches
  if (selectedTutorId && selectedTutorId !== 'none') {
    const tutorSubjects = [];
    for (const [subj, tutors] of Object.entries(db.subjectTutors)) {
      if (tutors.includes(selectedTutorId)) {
        tutorSubjects.push(subj);
      }
    }
    
    if (tutorSubjects.length > 0) {
      const filteredSubjOptions = tutorSubjects.slice(0, 24).map(s => ({ 
        label: s, 
        value: s,
        description: `Subject: ${s}` 
      }));
      
      // Only include "Use ticket subject" if tutor teaches it
      const options = [];
      if (tutorSubjects.includes(ticket.subject)) {
        options.push({ label: 'Use ticket subject', value: 'ticket_subject', description: `Ticket subject: ${ticket.subject}` });
      }
      options.push(...filteredSubjOptions);
      
      const newSubjectSelect = new StringSelectMenuBuilder()
        .setCustomId(`close_ticket_select|${code}|subject`)
        .setPlaceholder('Choose subject this tutor teaches')
        .addOptions(options);
        
        const updatedRows = [...interaction.message.components];
        updatedRows[2] = new ActionRowBuilder().addComponents(newSubjectSelect);
        
        saveDB();
        return interaction.update({ content: `Tutor selected. Now choose a subject this tutor teaches.`, components: updatedRows }).catch(() => {});
      }
    }
    saveDB();
    return interaction.update({ content: 'Selection saved. Now choose subject, then click "Provide reason and close".', components: interaction.message.components }).catch(() => {});
  } else if (which === 'subject') {
    const selected = interaction.values[0];
    ticket._closeFlowTemp.assignedSubject = selected === 'ticket_subject' ? ticket.subject : selected;
    console.log(`[CLOSE SELECT] Saved subject selection: ${ticket._closeFlowTemp.assignedSubject} for ticket ${code}`);
    console.log(`[CLOSE SELECT] Full temp data for ticket ${code}:`, JSON.stringify(ticket._closeFlowTemp));
    saveDB();
    console.log(`[CLOSE SELECT] Database saved after subject selection`);
    return interaction.update({ content: 'Selection saved, click "Provide reason and close" when ready.', components: interaction.message.components, ephemeral: true }).catch(() => {});
  }
      }


    }

    // CHAT INPUT COMMANDS
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // ENQUIRE (unchanged)
      if (cmd === 'enquire') {
        const uid = interaction.user.id;
        const last = db.cooldowns[uid] || 0;
        const cooldownMs = 3 * 60 * 1000;
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          const msLeft = cooldownMs - elapsed;
          const secs = Math.ceil(msLeft / 1000);
          return interaction.reply({ content: `Please wait ${secs}s before creating another enquiry.`, ephemeral: true });
        }

        await interaction.reply({ content: 'Creating your ticket...', ephemeral: true }).catch(() => {});

        const subject = interaction.options.getString('subject', true);
        const guild = interaction.guild;
        const code = generateTicketNumber();

        const overwrites = [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ...getStaffRoleIds().map(rid => ({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] })),
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.EmbedLinks] }
        ];
        const channelData = { name: `ticket-${code}`, type: 0, permissionOverwrites: overwrites };
        if (TICKET_CATEGORY_ID) channelData.parent = TICKET_CATEGORY_ID;
        const ticketChannel = await guild.channels.create(channelData).catch(err => { console.error('create channel failed', err); try { notifyStaffError(err, 'enquire create channel', interaction); } catch (e) {} return null; });
        if (!ticketChannel) return interaction.editReply({ content: `Failed to create ticket channel.`, ephemeral: true }).catch(() => {});

        const initMsg = db.initMessage.replace('{subject}', subject);
        await ticketChannel.send({ content: `<@${interaction.user.id}>\n${initMsg}` }).catch(() => {});

        db.tickets[code] = {
          ticketChannelId: ticketChannel.id,
          studentId: interaction.user.id,
          tutorMessageId: null,
          tutorThreadId: null,
          subject,
          approved: false,
          awaitingApproval: false,
          tutorCount: 0,
          tutorMap: {},
          messages: [],
          createdAt: Date.now()
        };
        db.cooldowns[interaction.user.id] = Date.now();
        saveDB();

        await interaction.editReply({ content: `Ticket created, code **${code}**. Continue in <#${ticketChannel.id}>.` }).catch(() => {});
        await ticketChannel.send(`Ticket ${code} created for ${interaction.user.tag}, subject: ${subject}`).catch(() => {});
        return;
      }

      // REPLY (unchanged)
      if (cmd === 'reply') {
        const code = interaction.options.getString('code', true);
        const messageText = interaction.options.getString('message', true);

        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: `Ticket ${code} not found.`, ephemeral: true });

        const is_staff = isStaff(interaction.member);
        const allowedTutorsArr = db.subjectTutors[ticket.subject] || [];
        const allowedTutors = new Set(allowedTutorsArr.map(id => String(id)));
        const userIdStr = String(interaction.user.id);
        const isTutorId = allowedTutors.has(userIdStr);

        if (!is_staff) {
          if (!ticket.approved) return interaction.reply({ content: 'This enquiry has not been approved yet, only staff can reply before approval.', ephemeral: true });
          if (!isTutorId) {
            console.warn(`Unauthorized reply attempt: user=${userIdStr}, subject=${ticket.subject}, ticket=${code}`);
            return interaction.reply({ content: 'Only tutors assigned to this subject or staff can reply.', ephemeral: true });
          }
        }

        ticket.tutorMap = ticket.tutorMap || {};
        ticket.tutorCount = ticket.tutorCount || 0;
        if (!ticket.tutorMap[userIdStr]) {
          ticket.tutorCount += 1;
          ticket.tutorMap[userIdStr] = ticket.tutorCount;
        }
        const tutorLabel = `Tutor ${ticket.tutorMap[userIdStr]}`;

        const guild = interaction.guild;
        const ticketChannel = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
        if (!ticketChannel) return interaction.reply({ content: 'Ticket channel not found.', ephemeral: true });

        try { await ticketChannel.send(`Reply from ${tutorLabel}: ${messageText}`).catch(() => {}); } catch (e) { console.warn('Failed send anon reply', e); try { notifyStaffError(e, 'reply send anon', interaction); } catch (err) {} }

        ticket.messages = ticket.messages || [];
        ticket.messages.push({ who: tutorLabel, tutorId: userIdStr, at: Date.now(), text: messageText });
        saveDB();

        try {
          if (ticket.tutorThreadId) {
            const thread = await guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
            if (thread && thread.isThread()) {
              await thread.send({ content: `Reply for ${code} from ${interaction.user.tag} (${tutorLabel}): ${messageText}` }).catch(() => {});
            }
          }
        } catch (e) { console.warn('Failed to post in tutors thread', e); try { notifyStaffError(e, 'reply post to thread', interaction); } catch (err) {} }

        return interaction.reply({ content: `Reply sent to ticket ${code}.`, ephemeral: true });
      }

// CLOSE command changed: send an ephemeral message with select menus and a button to open modal for reason
if (cmd === 'close') {
  const code = interaction.options.getString('code', true);
  
  // Check if this is a modmail ticket (format: \d+[ACSP])
  const modmailMatch = code.match(/^(\d+)([ACSPacsp])$/i);
  if (modmailMatch) {
    // This is a modmail ticket, route to modmail close handler
    const ticketNum = modmailMatch[1];
    const letter = modmailMatch[2].toUpperCase();
    
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });
    
    // Find the modmail ticket with matching ticketNum and letter
    let foundTicket = null;
    for (const [channelId, ticket] of Object.entries(db.modmail?.byChannel || {})) {
      if (String(ticket.id) === ticketNum && String(ticket.letter).toUpperCase() === letter) {
        foundTicket = ticket;
        break;
      }
    }
    
    if (!foundTicket) {
      return interaction.reply({ content: `Modmail ticket ${ticketNum}${letter} not found.`, ephemeral: true });
    }
    
    // If this is a tutor_application ticket, start the acceptance flow
    if (foundTicket.purpose === 'tutor_application') {
      const modal = new ModalBuilder().setCustomId(`mm_close_modal|${foundTicket.channelId}`).setTitle(`Close modmail ${ticketNum}${letter}`);
      const reasonInput = new TextInputBuilder().setCustomId('mm_close_reason').setLabel('Reason for closing (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      try { await interaction.showModal(modal); } catch (e) { console.warn('showModal mm_close failed', e); try { notifyStaffError(e, 'modmail close modal', interaction); } catch (err) {} return; }
      return;
    }
    
    // For other modmail types, close immediately
    try {
      foundTicket.closeReason = 'Staff closed via /close command';
      await db._modmail_helpers.closeTicketByChannel(foundTicket.channelId, `${interaction.user.tag} (staff)`);
      return interaction.reply({ content: `Modmail ticket ${ticketNum}${letter} closed.`, ephemeral: true });
    } catch (e) {
      console.warn('Failed to close modmail ticket', e);
      try { notifyStaffError(e, 'modmail close', interaction); } catch (err) {}
      return interaction.reply({ content: `Failed to close modmail ticket ${ticketNum}${letter}.`, ephemeral: true });
    }
  }
  
  // Regular ticket close flow
  const ticket = db.tickets[code];
  if (!ticket) return interaction.reply({ content: `Ticket ${code} not found.`, ephemeral: true });
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });

  // Build select for hired yes/no
  const hiredSelect = new StringSelectMenuBuilder()
    .setCustomId(`close_ticket_select|${code}|hired`)
    .setPlaceholder('Did the student hire a tutor?')
    .addOptions([
      { label: 'No', value: 'no', description: 'Student did not hire a tutor' },
      { label: 'Yes, hired tutor', value: 'yes', description: 'Student hired a tutor' }
    ]);

  // Build tutor select populated with known tutors (display usernames instead of IDs)
  const tutorOptions = [];
  const allTutorIds = Array.from(new Set(Object.values(db.subjectTutors).flat()));
  
  // Add a default option
  tutorOptions.push({ 
    label: 'Select a tutor...', 
    value: 'none',
    description: 'Choose a tutor if hired' 
  });

  for (const tid of allTutorIds.slice(0, 24)) { // Limit to 24 to stay under 25 total
    let label = `User ID: ${tid}`;
    let description = '';
    try {
      const m = await interaction.guild.members.fetch(tid).catch(() => null);
      if (m) {
        label = m.user.username;
        description = `(${m.user.tag})`;
      } else {
        const u = await client.users.fetch(tid).catch(() => null);
        if (u) {
          label = u.username;
          description = `(${u.tag})`;
        }
      }
    } catch (e) {}
    tutorOptions.push({ 
      label: label.substring(0, 100), 
      value: String(tid).substring(0, 100),
      description: description.substring(0, 50) 
    });
  }
  
  const tutorSelect = new StringSelectMenuBuilder()
    .setCustomId(`close_ticket_select|${code}|tutor`)
    .setPlaceholder('Choose tutor (if hired)')
    .addOptions(tutorOptions);

  // Subject select - will be updated dynamically when tutor is chosen
  const subjOptions = db.subjects.slice(0, 24).map(s => ({ 
    label: s, 
    value: s,
    description: `Subject: ${s}` 
  }));
  
  const subjectSelect = new StringSelectMenuBuilder()
    .setCustomId(`close_ticket_select|${code}|subject`)
    .setPlaceholder('Choose subject for assignment (if hired)')
    .addOptions([
      { label: 'Use ticket subject', value: 'ticket_subject', description: `Ticket subject: ${ticket.subject}` },
      ...subjOptions
    ]);

  const rows = [
    new ActionRowBuilder().addComponents(hiredSelect),
    new ActionRowBuilder().addComponents(tutorSelect),
    new ActionRowBuilder().addComponents(subjectSelect),
  ];
  // Button to open the modal for reason, modal id will be close_ticket_modal|CODE
  const buttonRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`open_close_modal|${code}`).setLabel('Provide reason and close').setStyle(ButtonStyle.Danger));

  return interaction.reply({ content: 'Please pick whether the student was hired, the tutor if yes, and the subject. Then click Provide reason and close.', components: [...rows, buttonRow], ephemeral: true });
}

      // subject / tutor / createad / editad / sticky / embedcolor / editinit / help / staffhelp
      if (cmd === 'subject') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage subjects.', ephemeral: true });
        const action = interaction.options.getString('action', true);
        const subj = interaction.options.getString('subject', false);
        if (action === 'add') {
          if (!subj) return interaction.reply({ content: 'Provide subject text to add.', ephemeral: true });
          if (db.subjects.includes(subj)) return interaction.reply({ content: 'Subject already exists.', ephemeral: true });
          db.subjects.push(subj); saveDB(); await registerCommands();
          return interaction.reply({ content: `Subject added: ${subj}`, ephemeral: true });
        } else if (action === 'remove') {
          if (!subj) return interaction.reply({ content: 'Provide subject text to remove.', ephemeral: true });
          db.subjects = db.subjects.filter(s => s !== subj); delete db.subjectTutors[subj]; saveDB(); await registerCommands();
          return interaction.reply({ content: `Subject removed: ${subj}`, ephemeral: true });
        } else {
          return interaction.reply({ content: `Subjects:\n${db.subjects.join('\n')}`, ephemeral: true });
        }
      }

      // tutor command extended to show students and reviews
      if (cmd === 'tutor') {
        const action = interaction.options.getString('action', true);
        const useridRaw = interaction.options.getString('userid', false);
        const subj = interaction.options.getString('subject', false);

        db.tutorProfiles = db.tutorProfiles || {};

        if (action === 'info') {
          if (!useridRaw) {
            // present a select of known tutors so staff don't need to type IDs
            const allTutorIds = Array.from(new Set(Object.values(db.subjectTutors).flat()));
            if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true });
            const options = [];
            for (const tid of allTutorIds.slice(0, 24)) {
              let label = `User ID: ${tid}`;
              let desc = '';
              try {
                const m = await interaction.guild.members.fetch(tid).catch(() => null);
                if (m) { label = m.user.username; desc = `(${m.user.tag})`; }
                else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } }
              } catch (e) {}
              // Show ad code(s) for this tutor if available
              const tutorAdCodes = Object.values(db.createAds || {}).filter(a => a.tutorId === tid && a.adCode).map(a => a.adCode);
              if (tutorAdCodes.length) desc = `${tutorAdCodes.join(', ')}${desc ? ' · ' + desc : ''}`;
              options.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
            }
            const select = new StringSelectMenuBuilder().setCustomId('tutor_select|info').setPlaceholder('Select a tutor to view info').addOptions(options);
            return interaction.reply({ content: 'Select a tutor to view info:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
          }
          // Resolve ad code to tutor ID if an ad code was provided
          let userid = String(useridRaw);
          if (isAdCode(userid)) {
            const resolved = resolveAdCodeToTutorId(userid);
            if (!resolved) return interaction.reply({ content: `No ad found with code **${userid}**. Please check the code and try again.`, ephemeral: true });
            userid = resolved;
          }
          const subjects = [];
          for (const s of db.subjects) {
            const arr = db.subjectTutors[s] || [];
            if (arr.includes(userid)) subjects.push(s);
          }
          // Find ad codes linked to this tutor
          const adCodesList = Object.values(db.createAds || {}).filter(a => a.tutorId === userid && a.adCode).map(a => a.adCode);
          const profile = db.tutorProfiles[userid] || { addedAt: null, students: [], reviews: [], rating: { count: 0, avg: 0 } };
          const addedAt = profile && profile.addedAt ? `<t:${Math.floor(profile.addedAt/1000)}:f>` : '(unknown)';
          let userTag = '(not in guild)';
          let joined = '(unknown)';
          try {
            const member = await interaction.guild.members.fetch(userid).catch(() => null);
            if (member) {
              userTag = member.user.tag;
              joined = member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime()/1000)}:f>` : '(unknown)';
            } else {
              const user = await client.users.fetch(userid).catch(() => null);
              if (user) userTag = user.tag;
            }
          } catch (e) {}
          const rating = profile.rating && profile.rating.count ? `${(Number(profile.rating.avg) || 0).toFixed(2)} ⭐️ (${profile.rating.count})` : '(no ratings)';
          const studentList = (profile.students && profile.students.length) ? profile.students.join(', ') : '(none)';
          const notes = profile.notes || '(no notes)';
          const lines = [
            `Tutor info for: ${userTag} (ID: ${userid})`,
            `Ad code(s): ${adCodesList.length ? adCodesList.join(', ') : '(none)'}`,
            `Guild joined: ${joined}`,
            `Tutor added at: ${addedAt}`,
            `Subjects: ${subjects.length ? subjects.join(', ') : '(none)'}`,
            `Assigned students: ${studentList}`,
            `Rating: ${rating}`,
            `Notes: ${notes}`
          ];
          return interaction.reply({ content: lines.join('\n'), ephemeral: true });
        }

        if (action === 'notes') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage tutor notes.', ephemeral: true });
          if (!useridRaw) {
            // present a select of tutors to open notes modal for
            const allTutorIds = Array.from(new Set(Object.values(db.subjectTutors).flat()));
            if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true });
            const options = [];
            for (const tid of allTutorIds.slice(0, 24)) {
              let label = `User ID: ${tid}`;
              let desc = '';
              try {
                const m = await interaction.guild.members.fetch(tid).catch(() => null);
                if (m) { label = m.user.username; desc = `(${m.user.tag})`; }
                else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } }
              } catch (e) {}
              options.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
            }
            const select = new StringSelectMenuBuilder().setCustomId('tutor_select|notes').setPlaceholder('Select a tutor to edit notes').addOptions(options);
            return interaction.reply({ content: 'Select a tutor to edit notes:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
          }

          const userid = String(useridRaw);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          
          const currentNotes = db.tutorProfiles[userid].notes || '';
          
          const modal = new ModalBuilder()
            .setCustomId(`tutor_notes_modal|${userid}`)
            .setTitle(`Tutor Notes`);
          
          const notesInput = new TextInputBuilder()
            .setCustomId('tutor_notes')
            .setLabel('Notes for this tutor')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setValue(currentNotes.substring(0, 4000))
            .setPlaceholder('Enter notes about this tutor...')
            .setMaxLength(4000);
          
          modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
          
          try {
            await interaction.showModal(modal);
          } catch (err) {
            console.error('showModal failed for tutor notes', err);
            try { notifyStaffError(err, 'tutor notes showModal', interaction); } catch (e) {}
            return interaction.reply({ content: 'Could not open notes modal, try again.', ephemeral: true });
          }
          return;
        }

        if (action === 'list') {
          if (subj) {
            const arr = db.subjectTutors[subj] || [];
            if (arr.length === 0) return interaction.reply({ content: `Tutors for ${subj}:\n(none)`, ephemeral: true });
            const lines = [];
            for (const id of arr) {
              let label = id;
              try {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m) label = `${m.user.username} (${id})`;
                else { const u = await client.users.fetch(id).catch(() => null); if (u) label = `${u.username} (${id})`; }
              } catch (e) {}
              lines.push(label);
            }
            return interaction.reply({ content: `Tutors for ${subj}:\n${lines.join('\n')}`, ephemeral: true });
          } else {
            const lines = [];
            for (const s of db.subjects) {
              const ids = db.subjectTutors[s] || [];
              if (ids.length === 0) lines.push(`${s}: (none)`);
              else {
                const formatted = [];
                for (const id of ids) {
                  let label = id;
                  try {
                    const m = await interaction.guild.members.fetch(id).catch(() => null);
                    if (m) label = `${m.user.username} (${id})`;
                    else { const u = await client.users.fetch(id).catch(() => null); if (u) label = `${u.username} (${id})`; }
                  } catch (e) {}
                  formatted.push(label);
                }
                lines.push(`${s}: ${formatted.join(', ')}`);
              }
            }
            return interaction.reply({ content: lines.join('\n'), ephemeral: true });
          }
        }

        // If removing and no userid was given, present subject+tutor selects when both missing,
        // or subject-specific tutor select when subject provided.
        if (action === 'remove' && !useridRaw) {
          // If no subject provided, show both subject select and tutor select (all known tutors)
          if (!subj) {
            const rows = [];

            // Subject select
            const subjOptions = (db.subjects || []).slice(0, 25).map(s => ({ label: s.substring(0,100), value: s.substring(0,100), description: `Subject: ${s}`.substring(0,50) }));
            if (subjOptions.length) {
              const subjectSelect = new StringSelectMenuBuilder().setCustomId('tutor_remove_select|subject').setPlaceholder('Select subject to remove tutor from').addOptions(subjOptions);
              rows.push(new ActionRowBuilder().addComponents(subjectSelect));
            }

            // Tutor select - include tutors present in db.subjectTutors
            const known = Array.from(new Set(Object.values(db.subjectTutors || {}).flat())).slice(0,24);
            const tutorOptions = [];
            for (const tid of known) {
              let label = `User ID: ${tid}`;
              let desc = '';
              try { const m = await interaction.guild.members.fetch(tid).catch(() => null); if (m) { label = m.user.username; desc = `(${m.user.tag})`; } else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } } } catch (e) {}
              tutorOptions.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
            }
            if (tutorOptions.length) {
              const tutorSelect = new StringSelectMenuBuilder().setCustomId('tutor_remove_select|tutor').setPlaceholder('Select tutor to remove').addOptions(tutorOptions);
              rows.push(new ActionRowBuilder().addComponents(tutorSelect));
            }

            if (!rows.length) return interaction.reply({ content: 'No subjects or tutors available to remove.', ephemeral: true });
            return interaction.reply({ content: 'Select subject and tutor to remove:', components: rows, ephemeral: true });
          }

          // If subject provided, show tutors for that subject only
          const arr = db.subjectTutors[subj] || [];
          if (!arr.length) return interaction.reply({ content: `No tutors for subject ${subj}.`, ephemeral: true });
          const options = [];
          for (const tid of arr.slice(0,24)) {
            let label = `User ID: ${tid}`;
            let desc = '';
            try { const m = await interaction.guild.members.fetch(tid).catch(() => null); if (m) { label = m.user.username; desc = `(${m.user.tag})`; } else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } } } catch (e) {}
            options.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
          }
          const select = new StringSelectMenuBuilder().setCustomId(`tutor_remove_select|tutor|${subj}`).setPlaceholder('Select tutor to remove from subject').addOptions(options);
          return interaction.reply({ content: `Select a tutor to remove from ${subj}:`, components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
        }

        if (!isStaff(interaction.member)) {
          return interaction.reply({ content: 'Only staff can manage tutors.', ephemeral: true });
        }

        // If add/remove called without both userid and subject, present selection UI
        if (!useridRaw || !subj) {
          // Prepare temp storage for this staff user
          db._tempTutorAdd = db._tempTutorAdd || {};
          const key = interaction.user.id;
          db._tempTutorAdd[key] = db._tempTutorAdd[key] || { subject: null, userid: null };
          if (subj) db._tempTutorAdd[key].subject = subj;
          if (useridRaw) db._tempTutorAdd[key].userid = String(useridRaw);
          saveDB();

          const rows = [];

          // Subject select if subject not provided
          if (!subj) {
            const subjOptions = (db.subjects || []).slice(0, 25).map(s => ({ label: s.substring(0,100), value: s.substring(0,100), description: `Subject: ${s}`.substring(0,50) }));
            if (subjOptions.length === 0) return interaction.reply({ content: 'No subjects available. Please add subjects first using /subject add', ephemeral: true });
            const subjectCustomId = action === 'remove' ? 'tutor_remove_select|subject' : 'tutor_add_select|subject';
            const subjectSelect = new StringSelectMenuBuilder().setCustomId(subjectCustomId).setPlaceholder(action === 'remove' ? 'Select subject to remove tutor from' : 'Select subject to add tutor to').addOptions(subjOptions);
            rows.push(new ActionRowBuilder().addComponents(subjectSelect));
          }

          // Tutor select if userid not provided
          if (!useridRaw) {
            const options = [];
            if (action === 'remove') {
              // For remove flow, only show tutors that exist in db.subjectTutors
              const known = Array.from(new Set(Object.values(db.subjectTutors || {}).flat()));
              for (const tid of known.slice(0,24)) {
                let label = `User ID: ${tid}`;
                let desc = '';
                try { const mm = await interaction.guild.members.fetch(tid).catch(() => null); if (mm) { label = mm.user.username; desc = `(${mm.user.tag})`; } else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } } } catch (e) {}
                options.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
              }
            } else {
              // Default add flow: fetch guild members first for convenience
              let members = null;
              try { members = await interaction.guild.members.fetch({ limit: 50 }).catch(() => null); } catch (e) { members = null; }
              if (members && members.size) {
                for (const m of Array.from(members.values()).slice(0,24)) {
                  const label = m.user.username.substring(0,100);
                  const desc = `(${m.user.tag})`.substring(0,50);
                  options.push({ label, value: m.id, description: desc });
                }
              }
              // Fallback: include known tutors (ids)
              if (!options.length) {
                const known = Array.from(new Set(Object.values(db.subjectTutors || {}).flat())).slice(0,24);
                for (const tid of known) {
                  let label = `User ID: ${tid}`;
                  let desc = '';
                  try { const mm = await interaction.guild.members.fetch(tid).catch(() => null); if (mm) { label = mm.user.username; desc = `(${mm.user.tag})`; } else { const u = await client.users.fetch(tid).catch(() => null); if (u) { label = u.username; desc = `(${u.tag})`; } } } catch (e) {}
                  options.push({ label: label.substring(0,100), value: String(tid).substring(0,100), description: desc.substring(0,50) });
                }
              }
            }

            if (options.length) {
              const customId = action === 'remove' ? 'tutor_remove_select|tutor' : 'tutor_add_select|tutor';
              const tutorSelect = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(action === 'remove' ? 'Select tutor to remove' : 'Select tutor to add').addOptions(options);
              rows.push(new ActionRowBuilder().addComponents(tutorSelect));
            }
          }

          if (!rows.length) return interaction.reply({ content: 'Nothing to select. Provide both userid and subject.', ephemeral: true });
          return interaction.reply({ content: 'Select subject and/or tutor to add (your selections will be saved).', components: rows, ephemeral: true });
        }

        const userid = String(useridRaw);
        db.subjectTutors[subj] = db.subjectTutors[subj] || [];

        if (action === 'add') {
          if (db.subjectTutors[subj].includes(userid)) {
            return interaction.reply({ content: 'User already added for this subject.', ephemeral: true });
          }

          db.subjectTutors[subj].push(userid);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
          saveDB();

          try {
            await interaction.reply({ content: `Added tutor ${userid} to ${subj}, access grant started.`, ephemeral: true });
          } catch (err) {
            try { await interaction.followUp({ content: `Added tutor ${userid} to ${subj}, access grant started.`, ephemeral: true }); } catch {}
          }

          (async () => {
            try {
              await grantTutorAccess(userid);
              console.log(`grantTutorAccess: finished for ${userid}`);
            } catch (e) {
              console.warn(`grantTutorAccess async failed for ${userid}`, e);
              try { notifyStaffError(e, 'grantTutorAccess async', interaction); } catch (err) {}
            }
          })();
          return;
        }

        if (action === 'remove') {
          db.subjectTutors[subj] = db.subjectTutors[subj].filter(id => id !== userid);
          saveDB();
          try {
            await revokeTutorAccess(userid);
          } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'revokeTutorAccess', interaction); } catch (err) {} }
          const tutorUser = await client.users.fetch(userid).catch(() => null);
          const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
          return interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true });
        }

        return interaction.reply({ content: 'Unknown action for tutor.', ephemeral: true });
      }

// Replace the current /createad command handler (around line 920-950) with:
if (cmd === 'createad') {
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can create ads.', ephemeral: true });

    // Acknowledge and fetch usernames into DB (may take time). We reply first to avoid "application did not respond".
    try {
      await interaction.reply({ content: 'Preparing ad modal and resolving tutor usernames, please wait...', ephemeral: true });
    } catch (e) { /* ignore */ }

    const allTutorIds = Array.from(new Set(Object.values(db.subjectTutors || {}).flat()));
    // For each tutor id, if we don't have a username stored, try to fetch the guild member or user and save it.
    const fetchPromises = allTutorIds.map(async (tid) => {
      try {
        if (!tid) return;
        db.tutorProfiles = db.tutorProfiles || {};
        db.tutorProfiles[tid] = db.tutorProfiles[tid] || { addedAt: null, students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        if (db.tutorProfiles[tid].username) return; // already known
        // Try guild member fetch (may take time) — this is OK because we've already replied.
        const member = await interaction.guild.members.fetch(tid).catch(() => null);
        if (member && member.user) {
          db.tutorProfiles[tid].username = member.user.username;
          db.tutorProfiles[tid].tag = member.user.tag;
          return;
        }
        const user = await client.users.fetch(tid).catch(() => null);
        if (user) {
          db.tutorProfiles[tid].username = user.username;
          db.tutorProfiles[tid].tag = user.tag;
        }
      } catch (e) { /* ignore per-user failures */ }
    });

    try {
      await Promise.allSettled(fetchPromises);
      saveDB();
    } catch (e) { /* ignore */ }

    // Now send a follow-up that asks for category first (University/A level/IGCSE/etc),
    // then enables opening the modal. We do this outside the modal to avoid Discord's 5-row modal limit.
    const levelOptions = [
      new StringSelectMenuOptionBuilder().setLabel('University').setValue('university'),
      new StringSelectMenuOptionBuilder().setLabel('A level').setValue('a_level'),
      new StringSelectMenuOptionBuilder().setLabel('IGCSE').setValue('igcse'),
      new StringSelectMenuOptionBuilder().setLabel('Below IGCSE').setValue('below_igcse'),
      new StringSelectMenuOptionBuilder().setLabel('Language').setValue('language'),
      new StringSelectMenuOptionBuilder().setLabel('Other').setValue('other')
    ];
    const levelSelect = new StringSelectMenuBuilder()
      .setCustomId(`createad_level|${interaction.user.id}`)
      .setPlaceholder('Select subject level category')
      .addOptions(levelOptions)
      .setRequired(true);
    const openButton = new ButtonBuilder()
      .setCustomId(`open_createad_modal|${interaction.user.id}|other`)
      .setLabel('Open Create Ad Modal')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true);

    await interaction.followUp({
      content: 'Ready — select the subject level category, then open the ad modal.',
      components: [new ActionRowBuilder().addComponents(levelSelect), new ActionRowBuilder().addComponents(openButton)],
      ephemeral: true
    }).catch(() => {});
    return;
}

      // editad command prefill modal
      if (cmd === 'editad') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit ads.', ephemeral: true });
        const messageId = interaction.options.getString('messageid', true);
        
        // First, check if this is a category channel message ID
        let adData = null;
        let foundInFindChannel = false;
        let foundInCategoryChannel = false;
        
        // Check find-a-tutor channel
        const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
        let msg = null;
        if (findChannel) {
          msg = await findChannel.messages.fetch(messageId).catch(() => null);
          if (msg) {
            foundInFindChannel = true;
            adData = db.createAds[messageId];
          }
        }
        
        // If not found in find channel, search category channels using stored ad data
        if (!msg) {
          // Find the ad entry whose categoryMessageId matches the provided messageId
          let matchedAdData = null;
          for (const [msgId, data] of Object.entries(db.createAds || {})) {
            if (data.categoryMessageId === messageId) {
              matchedAdData = data;
              break;
            }
          }

          if (matchedAdData && matchedAdData.categoryChannelId) {
            const categoryCh = await interaction.guild.channels.fetch(matchedAdData.categoryChannelId).catch(() => null);
            if (categoryCh) {
              const categoryMsg = await categoryCh.messages.fetch(messageId).catch(() => null);
              if (categoryMsg) {
                msg = categoryMsg;
                foundInCategoryChannel = true;
                adData = matchedAdData;
              }
            }
          }
        }
        
        if (!msg) return interaction.reply({ content: `Message ${messageId} not found in find-a-tutor or any category channel.`, ephemeral: true });

        const embed = msg.embeds && msg.embeds.length ? msg.embeds[0] : null;
        const preTitle = embed?.title || '';
        const preDesc = embed?.description || '';
        const preColor = adData?.embed?.color || null;
        
        // Extract role mention from message content if exists
        let preRoleId = '';
        if (msg.content) {
            const roleMatch = msg.content.match(/<@&(\d+)>/);
            if (roleMatch) {
                preRoleId = roleMatch[1];
            }
        }

        // Create subject select menu with current subject pre-selected
        const subjectOptions = (db.subjects || []).slice(0, 25).map(s => {
            const option = new StringSelectMenuOptionBuilder()
                .setLabel(s.substring(0, 100))
                .setValue(s.substring(0, 100))
                .setDescription(clampLabel(`Select ${s}`, 50));
            if (s === preTitle) {
                option.setDefault(true);
            }
            return option;
        });
        
        if (subjectOptions.length === 0) {
            return interaction.reply({ content: 'No subjects available. Please add subjects first using /subject add', ephemeral: true });
        }
        
        const subjectSelect = new StringSelectMenuBuilder()
            .setCustomId('edit_ad_subject')
            .setPlaceholder('Select a subject')
            .addOptions(subjectOptions)
            .setRequired(true);
        
        const subjectLabel = new LabelBuilder()
            .setLabel('Subject')
            .setStringSelectMenuComponent(subjectSelect);

        const modal = new ModalBuilder().setCustomId(`editad_modal|${messageId}|${foundInCategoryChannel ? 'category' : 'find'}`).setTitle(`Edit ad ${messageId}`);
        const msgInput = new TextInputBuilder().setCustomId('edit_ad_message').setLabel('Ad message').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((preDesc || '').substring(0, 4000));
        
        const colorInput = new TextInputBuilder()
            .setCustomId('edit_ad_color')
            .setLabel('Optional embed color, example #ff0000')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(preColor ? (preColor.startsWith('#') ? preColor : `#${preColor}`) : '');
        
        const roleInput = new TextInputBuilder()
            .setCustomId('edit_ad_role_mention')
            .setLabel('Optional subject role mention')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Enter role ID to mention')
            .setValue(preRoleId);
        
        modal.addComponents(
            subjectLabel,
            new ActionRowBuilder().addComponents(msgInput),
            new ActionRowBuilder().addComponents(colorInput),
            new ActionRowBuilder().addComponents(roleInput)
        );
        try { await interaction.showModal(modal); } catch (err) { console.error('showModal editad failed', err); try { notifyStaffError(err, 'showModal editad', interaction); } catch (e) {} return interaction.reply({ content: 'Could not open edit modal, try again.', ephemeral: true }); }
        return;
      }

      // sticky command shows modal (prefill)
      if (cmd === 'sticky') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set sticky message.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId('sticky_modal').setTitle('Set sticky message');
        const titleInput = new TextInputBuilder().setCustomId('sticky_title').setLabel('Sticky title').setStyle(TextInputStyle.Short).setRequired(false).setValue((db.sticky?.title || '').substring(0, 100));
        const bodyInput = new TextInputBuilder().setCustomId('sticky_body').setLabel('Sticky body').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((db.sticky?.body || '').substring(0, 4000));
        modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(bodyInput));
        return interaction.showModal(modal);
      }

      // embedcolor
      if (cmd === 'embedcolor') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set embed color.', ephemeral: true });
        const hex = interaction.options.getString('hex', true);

        db.defaultEmbedColor = hex;
        saveDB();

        if (db.sticky) {
          db.sticky.color = hex;
          saveDB();
          try {
            const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
            if (findChannel) {
              await repostStickyInChannel(findChannel);
            }
          } catch (e) {
            console.warn('reposting sticky after embedcolor failed', e);
            try { notifyStaffError(e, 'embedcolor repostSticky', interaction); } catch (err) {}
          }
        }

        return interaction.reply({ content: `Default embed color set to ${hex}`, ephemeral: true });
      }

      // editinit command now opens modal with prefilled value
      if (cmd === 'editinit') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit init message.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId('editinit_modal').setTitle('Edit initial ticket message');
        const initInput = new TextInputBuilder()
          .setCustomId('init_message')
          .setLabel('Initial message, use {subject}')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue((db.initMessage || '').substring(0, 4000));
        modal.addComponents(new ActionRowBuilder().addComponents(initInput));
        return interaction.showModal(modal);
      }

      if (cmd === 'help') return interaction.reply({ content: `Commands:\n/enquire subject:<choice>\n/reply code message\n/help\n/bumpleaderboard`, ephemeral: true });

      if (cmd === 'staffhelp') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can access this.', ephemeral: true });
        return interaction.reply({ content: `Staff Commands:\n/subject add/remove/list\n/tutor add/remove/list/info\n/createad\n/editad\n/sticky\n/embedcolor\n/editinit\n/close\n/student add/remove\n/reviewreminder\n/migrateads [force:true]`, ephemeral: true });
      }

      // bumpleaderboard command
      if (cmd === 'bumpleaderboard') {
        if (!db.bumpLeaderboard || Object.keys(db.bumpLeaderboard).length === 0) {
          return interaction.reply({ content: 'No bumps tracked yet! Use `/bump` to bump the server and start tracking.', ephemeral: false });
        }

        // Sort users by bump count (descending)
        const sorted = Object.entries(db.bumpLeaderboard)
          .map(([userId, data]) => ({ userId, count: data.count || 0, lastBump: data.lastBump || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10); // Top 10

        if (sorted.length === 0) {
          return interaction.reply({ content: 'No bumps tracked yet! Use `/bump` to bump the server and start tracking.', ephemeral: false });
        }

        // Build leaderboard embed
        const embed = new EmbedBuilder()
          .setTitle('🏆 Bump Leaderboard')
          .setDescription('Top bumpers in the server!')
          .setColor(0x5865F2) // Discord blurple
          .setTimestamp();

        let leaderboardText = '';
        for (let i = 0; i < sorted.length; i++) {
          const { userId, count } = sorted[i];
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          try {
            const user = await client.users.fetch(userId).catch(() => null);
            const username = user ? user.username : `Unknown (${userId})`;
            leaderboardText += `${medal} **${username}** - ${count} bump${count !== 1 ? 's' : ''}\n`;
          } catch (e) {
            leaderboardText += `${medal} <@${userId}> - ${count} bump${count !== 1 ? 's' : ''}\n`;
          }
        }

        embed.setDescription(leaderboardText || 'No bumps tracked yet!');

        return interaction.reply({ embeds: [embed], ephemeral: false });
      }

      // STUDENT command: add/remove
      if (cmd === 'student') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage students.', ephemeral: true });
        const action = interaction.options.getString('action', true);
        const studentId = interaction.options.getString('studentid', true);
        const tutorId = interaction.options.getString('tutorid', true);
        const subject = interaction.options.getString('subject', false) || '(unspecified)';

        if (!db.tutorProfiles[tutorId]) db.tutorProfiles[tutorId] = { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };

        if (action === 'add') {
          if (!db.tutorProfiles[tutorId].students) db.tutorProfiles[tutorId].students = [];
          if (!db.tutorProfiles[tutorId].students.includes(studentId)) db.tutorProfiles[tutorId].students.push(studentId);
          db.studentAssignments[studentId] = { tutorId, subject, assignedAt: Date.now(), reviewScheduledAt: Date.now() + (db.reviewConfig.delaySeconds || 1296000)*1000 };
          saveDB();
          return interaction.reply({ content: `Student ${studentId} assigned to tutor ${tutorId} for ${subject}`, ephemeral: true });
        } else {
          // remove
          if (db.tutorProfiles[tutorId] && db.tutorProfiles[tutorId].students) db.tutorProfiles[tutorId].students = db.tutorProfiles[tutorId].students.filter(s => s !== studentId);
          if (db.studentAssignments[studentId] && db.studentAssignments[studentId].tutorId === tutorId) delete db.studentAssignments[studentId];
          saveDB();
          return interaction.reply({ content: `Student ${studentId} removed from tutor ${tutorId}`, ephemeral: true });
        }
      }

      // reviewreminder - simple setter
            if (cmd === 'reviewreminder') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can change review reminder.', ephemeral: true });
        const seconds = Number(interaction.options.getString('seconds', true));
        if (!seconds || seconds <= 0) return interaction.reply({ content: 'Provide a positive number of seconds.', ephemeral: true });
        db.reviewConfig.delaySeconds = Math.max(1, Math.floor(seconds));
        saveDB();
        return interaction.reply({ content: `Review reminder set to ${db.reviewConfig.delaySeconds} second(s).`, ephemeral: true });
      }

      if (cmd === 'migrateads') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can run ad migration.', ephemeral: true });
        const force = interaction.options.getBoolean('force') || false;

        const MIGRATE_MAX_DESCRIPTION_LINES = 4;
        const MIGRATE_RATE_LIMIT_DELAY_MS = 1000;

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        // Ensure all guild channels are in the cache so findSubjectChannel can
        // locate category and subject channels by name.
        await interaction.guild.channels.fetch().catch(() => {});

        const allAds = Object.entries(db.createAds || {});
        const toMigrate = force
          ? allAds
          : allAds.filter(([, data]) => !data.categoryMessageId);

        if (toMigrate.length === 0) {
          return interaction.editReply({ content: force ? 'No ads found in the database.' : 'All ads already have a category message. Use `force:true` to re-post.' });
        }

        await interaction.editReply({ content: `Migrating ${toMigrate.length} ad(s)… please wait.` });

        let migrated = 0;
        let skipped = 0;
        const errors = [];

        for (const [messageId, adData] of toMigrate) {
          try {
            const subject = adData.embed && adData.embed.title ? adData.embed.title : null;
            // Fall back to auto-detecting the level from the subject name so that
            // ads created before the level field was introduced still get routed
            // to the correct category (e.g. "IGCSE Maths" → igcse, not "other").
            const levelKey = adData.level || detectLevelFromSubject(subject) || 'other';
            const tutorId = adData.tutorId || null;
            const embedDescription = adData.embed && adData.embed.description ? adData.embed.description : '';

            if (!subject) { skipped++; continue; }

            const categoryCh = await findSubjectChannel(interaction.guild, levelKey, subject).catch(() => null);
            if (!categoryCh) {
              if (process.env.DEBUG_MIGRATEADS) console.debug(`[migrateads] skip ${messageId}: no channel for subject="${subject}" level="${levelKey}"`);
              skipped++;
              continue;
            }

            const shortContent = [
              `**${subject}**`,
              tutorId ? `Tutor: <@${tutorId}>` : null,
              embedDescription ? embedDescription.split('\n').slice(0, MIGRATE_MAX_DESCRIPTION_LINES).join('\n') : null,
              FIND_A_TUTOR_CHANNEL_ID ? `*See full ad in <#${FIND_A_TUTOR_CHANNEL_ID}>*` : null
            ].filter(Boolean).join('\n');

            const sent = await categoryCh.send({ content: shortContent }).catch(() => null);
            if (sent) {
              db.createAds[messageId].categoryChannelId = categoryCh.id;
              db.createAds[messageId].categoryMessageId = sent.id;
              saveDB();
              migrated++;
            } else {
              skipped++;
            }

            // Small delay to respect Discord rate limits
            await new Promise(resolve => setTimeout(resolve, MIGRATE_RATE_LIMIT_DELAY_MS));
          } catch (e) {
            console.warn('migrateads: error migrating ad', messageId, e);
            errors.push(messageId);
          }
        }

        const summary = [`Migration complete!`, `✅ Migrated: ${migrated}`, `⏭️ Skipped: ${skipped}`];
        if (errors.length > 0) summary.push(`❌ Errors: ${errors.length} (check logs)`);
        return interaction.editReply({ content: summary.join('\n') });
      }

      if (cmd === 'exportchannels') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true }).catch(err => console.warn('exportchannels: deferReply failed', err));

        const guild = interaction.guild;
        const allChannels = guild.channels.cache;

        // Build category map
        const categoriesMap = {};
        for (const [id, ch] of allChannels) {
          if (ch.type === ChannelType.GuildCategory) {
            categoriesMap[id] = { id, name: ch.name, position: ch.position ?? null, channels: [] };
          }
        }
        const uncategorizedChannels = [];

        for (const [id, ch] of allChannels) {
          if (ch.type === ChannelType.GuildCategory) continue;
          const entry = { id, name: ch.name, type: ch.type, parentId: ch.parentId || null, position: ch.position ?? null };
          if (ch.parentId && categoriesMap[ch.parentId]) {
            categoriesMap[ch.parentId].channels.push(entry);
          } else {
            uncategorizedChannels.push(entry);
          }
        }

        // Sort channels within each category by position
        for (const cat of Object.values(categoriesMap)) {
          cat.channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        }
        uncategorizedChannels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

        const output = {
          guildId: guild.id,
          guildName: guild.name,
          exportedAt: new Date().toISOString(),
          categories: Object.values(categoriesMap).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
          uncategorized: uncategorizedChannels
        };

        const json = JSON.stringify(output, null, 2);

        // Try to send as a file attachment; fall back to chunked text
        try {
          const buf = Buffer.from(json, 'utf8');
          const attachment = new AttachmentBuilder(buf, { name: 'channels-export.json' });
          return interaction.editReply({ files: [attachment] });
        } catch (e) {
          console.warn('exportchannels: attachment send failed, falling back to chunked text', e);
          const chunks = [];
          for (let i = 0; i < json.length; i += 1900) chunks.push(json.slice(i, i + 1900));
          await interaction.editReply({ content: `\`\`\`json\n${chunks[0]}\n\`\`\`` });
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: `\`\`\`json\n${chunks[i]}\n\`\`\``, ephemeral: true });
          }
          return;
        }
      }
    }
  } catch (err) {
    console.error('interaction error', err);
    try { await notifyStaffError(err, 'interactionCreate', interaction); } catch (e) { console.warn('notifyStaffError failed', e); }
    try {
      if (interaction && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'An error occurred, staff have been notified.', ephemeral: true });
      else if (interaction && !interaction.replied) await interaction.followUp({ content: 'An error occurred, staff have been notified.', ephemeral: true });
    } catch (e) { /* ignore */ }
  }
});

// messageCreate handler — tickets, sticky repost on normal messages, tutors feed policing
client.on('messageCreate', async (message) => {
  try {
    // Check for Disboard bump success messages (Disboard bot ID: 302050872383242240)
    const DISBOARD_BOT_ID = '302050872383242240';
    if (message.author?.id === DISBOARD_BOT_ID) {
      // Check if we should only listen in a specific channel
      if (BUMP_CHANNEL_ID && String(message.channel.id) !== String(BUMP_CHANNEL_ID)) {
        return; // Not in the specified bump channel, ignore
      }
      
      const content = (message.content?.toLowerCase() || '');
      const embedContent = message.embeds?.length > 0 
        ? (message.embeds[0].description?.toLowerCase() || message.embeds[0].title?.toLowerCase() || '')
        : '';
      const allContent = content + ' ' + embedContent;
      
      // Disboard sends messages like "Bump done! :thumbsup:" or similar when a bump is successful
      // Also check for variations like "bumped", "bump done", etc.
      const isBumpSuccess = allContent.includes('bump') && (
        allContent.includes('done') || 
        allContent.includes('success') || 
        allContent.includes('complete') ||
        allContent.includes('bumped') ||
        allContent.includes('thank')
      );
      
      if (isBumpSuccess) {
        // Try to find who bumped by checking message mentions or interaction
        let bumperId = null;
        
        // First priority: Check the interaction property (most reliable for slash commands)
        if (message.interaction) {
          bumperId = message.interaction.user.id;
        }
        // Second priority: Check if message mentions a user
        else if (message.mentions.users.size > 0) {
          bumperId = message.mentions.users.first().id;
        }
        // Fallback: check recent messages for /bump command usage
        // This is less reliable but better than nothing
        else {
          try {
            const recentMessages = await message.channel.messages.fetch({ limit: 10 });
            for (const [id, msg] of recentMessages) {
              if (msg.content?.toLowerCase().includes('/bump') && !msg.author.bot) {
                bumperId = msg.author.id;
                break;
              }
            }
          } catch (e) {
            console.warn('Failed to fetch recent messages for bump tracking', e);
          }
        }
        
        if (bumperId) {
          // Initialize if doesn't exist
          if (!db.bumpLeaderboard) db.bumpLeaderboard = {};
          if (!db.bumpLeaderboard[bumperId]) {
            db.bumpLeaderboard[bumperId] = { count: 0, lastBump: null };
          }
          db.bumpLeaderboard[bumperId].count++;
          db.bumpLeaderboard[bumperId].lastBump = Date.now();
          saveDB();
          console.log(`Tracked bump for user ${bumperId}, total bumps: ${db.bumpLeaderboard[bumperId].count}`);
          
          // React with ⏱️ emoji to indicate bump was tracked
          try {
            await message.react('⏱️');
          } catch (e) {
            console.warn('Failed to react to bump message', e);
          }
        } else {
          console.warn('Could not determine who bumped the server from Disboard message');
        }
      }
    }
    
    if (message.author?.bot) return;

    // sticky: if any message posted in find-a-tutor, repost sticky immediately (no staff ping)
    if (String(message.channel.id) === String(FIND_A_TUTOR_CHANNEL_ID)) {
      try {
        await repostStickyInChannel(message.channel);
      } catch (e) {
        console.warn('sticky repost failed', e);
        try { notifyStaffError(e, 'messageCreate repostSticky', message); } catch (err) {}
      }
    }

    // find ticket by channel id
    const ticketEntry = Object.entries(db.tickets).find(([code, t]) => t.ticketChannelId === message.channel.id);
    if (ticketEntry) {
      const [code, ticket] = ticketEntry;
      const attachments = message.attachments && message.attachments.size ? Array.from(message.attachments.values()).map(a => a.url) : [];

      if (message.author.id === ticket.studentId) {
        ticket.messages.push({ who: 'Student', at: Date.now(), text: message.content || '', attachments });
        saveDB();

        if (!ticket.approved) {
          if (!ticket.awaitingApproval) {
            ticket.awaitingApproval = true;
            saveDB();

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`approve|${code}`).setLabel('Approve').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`deny|${code}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
            );

            const content = `Please do not type anything else until staff approves your message, as the tutors will only be able to see your first message.`;
            await message.channel.send({ content, components: [row] }).catch(() => {});
            return;
          }

          // Already awaiting approval, echo follow-ups without pinging staff
          try {
            let echo = `Please do not type anything else, staff are reviewing your message.\n\n`;
            echo += message.content && message.content.trim().length ? `> ${message.content}` : '> (no text)';
            if (attachments.length) echo += `\n\nAttachment(s): ${attachments.join(' ')}`;
            await message.channel.send({ content: echo }).catch(() => {});
          } catch (e) {
            console.warn('failed to echo student follow-up', e);
            try { notifyStaffError(e, 'messageCreate echo follow-up', message); } catch (err) {}
          }
        } else {
          // approved flow forwards to tutors thread
          if (ticket.tutorThreadId) {
            try {
              const thread = await message.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
              if (thread && thread.isThread()) {
                let content = `Student ${code} says: ${message.content || ''}`;
                if (attachments.length) content += `\nAttachment(s): ${attachments.join(' ')}`;
                await thread.send({ content }).catch(() => {});
              }
            } catch (e) {
              console.warn('forward fail', e);
              try { notifyStaffError(e, 'messageCreate forward to tutors thread', message); } catch (err) {}
            }
          }
        }
      } else {
        // staff or other wrote in ticket
        ticket.messages.push({ who: `Staff ${message.author.id}`, at: Date.now(), text: message.content || '', attachments });
        saveDB();
      }
      return;
    }

    // Tutors feed thread policing
    if (message.channel?.isThread && typeof message.channel.isThread === 'function' && message.channel.isThread()) {
      const parent = await message.channel.fetch(true).catch(() => null);
      if (parent && parent.parentId === TUTORS_FEED_CHANNEL_ID) {
        if (!message.author.bot) {
          try { await message.delete().catch(() => {}); } catch (err) { console.warn('failed delete tutor thread message', err); try { notifyStaffError(err, 'messageCreate delete tutors thread message', message); } catch (e) {} }
          try { await message.author.send('Please use the /reply command to reply to students, example: /reply 12 Hello, I can help.').catch(() => {}); } catch (err) { console.warn('failed DM tutor about reply usage', err); try { notifyStaffError(err, 'messageCreate DM tutor guidance', message); } catch (e) {} }
        }
      }
    }

    // Ads channel sync
    if (ADS_CHANNEL_ID && SYNC_WEBHOOK_URL && String(message.channel?.id) === String(ADS_CHANNEL_ID)) {
      try {
        await fetch(SYNC_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-TL-Sync-Secret': SYNC_SECRET || '' },
          body: JSON.stringify({ event: 'messageCreate', messageId: message.id, channelId: message.channel.id, authorId: message.author?.id, content: message.content, embeds: message.embeds.map(e => e.toJSON()), attachments: [...message.attachments.values()].map(a => ({ id: a.id, url: a.url, name: a.name, size: a.size })) })
        });
      } catch (e) { console.warn('ads sync messageCreate failed', e); }
    }
  } catch (e) {
    console.warn('messageCreate handler error', e);
    try { await notifyStaffError(e, 'messageCreate handler', message); } catch (err) { console.warn('notifyStaffError failed', err); }
  }
});

// messageUpdate handler — sync edits in ADS_CHANNEL_ID
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!ADS_CHANNEL_ID || !SYNC_WEBHOOK_URL) return;
  if (String(newMessage.channel?.id) !== String(ADS_CHANNEL_ID)) return;
  try {
    await fetch(SYNC_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Sync-Secret': SYNC_SECRET || '' },
      body: JSON.stringify({ event: 'messageUpdate', messageId: newMessage.id, channelId: newMessage.channel.id, authorId: newMessage.author?.id, content: newMessage.content, embeds: (newMessage.embeds || []).map(e => e.toJSON()), attachments: [...(newMessage.attachments?.values() || [])].map(a => ({ id: a.id, url: a.url, name: a.name, size: a.size })) })
    });
  } catch (e) { console.warn('ads sync messageUpdate failed', e); }
});

// messageDelete handler — sync deletions in ADS_CHANNEL_ID
client.on('messageDelete', async (message) => {
  if (!ADS_CHANNEL_ID || !SYNC_WEBHOOK_URL) return;
  if (String(message.channel?.id) !== String(ADS_CHANNEL_ID)) return;
  try {
    await fetch(SYNC_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TL-Sync-Secret': SYNC_SECRET || '' },
      body: JSON.stringify({ event: 'messageDelete', messageId: message.id, channelId: message.channel.id })
    });
  } catch (e) { console.warn('ads sync messageDelete failed', e); }
});

// Review reminder worker
setInterval(async () => {
  try {
    const now = Date.now();
    for (const [studentId, asg] of Object.entries(db.studentAssignments || {})) {
      if (!asg || !asg.reviewScheduledAt) continue;
      if (asg.reviewSentAt) continue; // already sent
      if (now >= asg.reviewScheduledAt) {
        // send DM to student asking for review, mark as sent time
        try {
          const student = await client.users.fetch(studentId).catch(() => null);
          if (student) {
            // simple message with button to submit review (modal via interaction required)
            const rows = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`review_start|${studentId}|${asg.tutorId}`).setLabel('Leave a review').setStyle(ButtonStyle.Primary)
            );
            await student.send({ content: `Hi, it's been a while since your class. Would you like to leave a review for your tutor?`, components: [rows] }).catch(() => {});
            // flag that we've sent reminder
            db.studentAssignments[studentId].reviewSentAt = now;
            saveDB();
            // notify staff
            try {
              const staffCh = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
              if (staffCh) await staffCh.send({ content: `Review reminder sent to <@${studentId}> for tutor <@${asg.tutorId}>` }).catch(() => {});
            } catch (e) {}
          }
        } catch (e) { console.warn('failed to send review reminder', e); try { notifyStaffError(e, 'review reminder worker'); } catch (err) {} }
      }
    }
  } catch (e) { console.warn('review reminder worker error', e); }
}, 60 * 1000); // runs every minute

client.login(BOT_TOKEN).catch(err => {
  console.error('login failed', err);
  try { notifyStaffError(err, 'client.login'); } catch (e) { console.warn('notify failed login', e); }
});
