'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { loadIndex, saveIndex, loadProgress, saveProgress, saveStatus, ensureDir } = require('./storage');
const { sanitizeFilename, sanitizeProjectFolder, getDatePrefix, conversationToMarkdown } = require('./formatter');
const { fetchConversation, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('./api');
const { downloadConversationFiles, downloadProjectFiles, retryPendingFiles } = require('./downloader');
const { throttle, restorePacingSnapshot, getPacingStats, resetSessionPacingStats } = require('./auth');

// Shared between run() and the conversation loop so saveStatus can record a
// stable start time regardless of where it's called from.
let runStartTime = null;
const UPDATE_HORIZON_CAP = 50;

function conversationTimestamp(conv) {
  const value = conv.update_time ?? conv.create_time ?? 0;
  if (typeof value === 'number') return value;

  const parsedNumber = Number(value);
  if (!Number.isNaN(parsedNumber)) return parsedNumber;

  const parsedDate = Date.parse(value);
  return Number.isNaN(parsedDate) ? 0 : parsedDate / 1000;
}

function findExistingConversationFiles(conv) {
  const shortId = conv.id.substring(0, 13);
  const files = [];

  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.includes(shortId) && (f.endsWith('.json') || f.endsWith('.md'))) {
        files.push(path.join(dir, f));
      }
    }
  };

  collect(PATHS.jsonDir);
  collect(PATHS.mdDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      collect(path.join(PATHS.projectsDir, entry.name, 'json'));
      collect(path.join(PATHS.projectsDir, entry.name, 'markdown'));
    }
  }

  return files;
}

function readExportedUpdateTime(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.json')) {
      return JSON.parse(content).update_time || null;
    }
    const match = content.match(/^update_time:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function collectExportedArtifactTimes() {
  const exported = new Map();
  const remember = (id, kind, updateTime) => {
    if (!id || !updateTime) return;
    const entry = exported.get(id) || {};
    const existing = entry[kind];
    if (!existing || conversationTimestamp({ update_time: updateTime }) > conversationTimestamp({ update_time: existing })) {
      entry[kind] = updateTime;
      exported.set(id, entry);
    }
  };

  const scanJsonDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        remember(data.id || data.conversation_id, 'json', data.update_time);
      } catch {}
    }
  };

  const scanMdDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const id = content.match(/^id:\s*(.+)$/m)?.[1]?.trim();
        const updateTime = content.match(/^update_time:\s*(.+)$/m)?.[1]?.trim();
        remember(id, 'markdown', updateTime);
      } catch {}
    }
  };

  scanJsonDir(PATHS.jsonDir);
  scanMdDir(PATHS.mdDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanJsonDir(path.join(PATHS.projectsDir, entry.name, 'json'));
      scanMdDir(path.join(PATHS.projectsDir, entry.name, 'markdown'));
    }
  }

  return exported;
}

function conversationNeedsUpdate(conv, exportedArtifactTimes = null) {
  if (exportedArtifactTimes) {
    const exported = exportedArtifactTimes.get(conv.id);
    if (!exported) return true;

    const targetTimestamp = conversationTimestamp(conv);
    const hasCurrent = (kind) => {
      const updateTime = exported[kind];
      return !!updateTime && conversationTimestamp({ update_time: updateTime }) >= targetTimestamp;
    };

    if (CONFIG.exportFormat === 'json') return !hasCurrent('json');
    if (CONFIG.exportFormat === 'markdown') return !hasCurrent('markdown');
    return !hasCurrent('json') || !hasCurrent('markdown');
  }

  const files = findExistingConversationFiles(conv);
  if (files.length === 0) return true;

  const targetTimestamp = conversationTimestamp(conv);
  return !files.some(file => {
    const exportedUpdateTime = readExportedUpdateTime(file);
    if (!exportedUpdateTime) return false;
    return conversationTimestamp({ update_time: exportedUpdateTime }) >= targetTimestamp;
  });
}

function updateMaxDownloadWindow(conversations, exportedArtifactTimes) {
  let limit = Math.min(CONFIG.maxConversations, UPDATE_HORIZON_CAP);
  const scanLimit = Math.min(conversations.length, UPDATE_HORIZON_CAP);
  let furthestPendingRank = 0;

  for (let i = 0; i < scanLimit; i++) {
    if (conversationNeedsUpdate(conversations[i], exportedArtifactTimes)) {
      furthestPendingRank = i + 1;
    }
  }

  while (limit < furthestPendingRank) {
    const nextLimit = Math.min(limit + 5, UPDATE_HORIZON_CAP);
    console.log(`  Update window has pending conversation at rank ${furthestPendingRank}; expanding to ${nextLimit} conversations`);
    limit = nextLimit;
  }

  if (furthestPendingRank >= UPDATE_HORIZON_CAP && conversations.length > UPDATE_HORIZON_CAP) {
    throw new Error(
      'UPDATE_DOWNLOAD_LIMIT_EXCEEDED: update mode still has unsynced conversations at 50; manual inspection or full refresh is required.'
    );
  }

  const checkedTail = scanLimit - limit;
  if (checkedTail > 0) {
    console.log(`  Update tail closed at ${limit}: no pending conversations in next ${checkedTail} checked`);
  } else {
    console.log(`  Update tail closed at ${limit}: no more indexed conversations in checked range`);
  }

  return conversations.slice(0, limit);
}

function updateCatchupStats(conversations, exportedArtifactTimes) {
  let current = 0;
  let pending = 0;
  for (const conv of conversations) {
    if (conversationNeedsUpdate(conv, exportedArtifactTimes)) pending++;
    else current++;
  }
  return { current, pending };
}

function usesUnifiedProjectUpdateWindow() {
  return CONFIG.includeProjects &&
    !CONFIG.projectsOnly &&
    CONFIG.updateExisting &&
    CONFIG.maxConversations !== null;
}

function trackedDownloadCounts(progress) {
  const regularIds = new Set(progress.downloadedIds || []);
  const projectIds = new Set();

  for (const projectProgress of Object.values(progress.projects || {})) {
    for (const id of projectProgress?.downloadedIds || []) {
      projectIds.add(id);
    }
  }

  const totalIds = new Set([...regularIds, ...projectIds]);
  let projectOnly = 0;
  for (const id of projectIds) {
    if (!regularIds.has(id)) projectOnly++;
  }

  return {
    total: totalIds.size,
    regular: regularIds.size,
    projectOnly,
  };
}

async function exportConversations(accessToken, progress) {
  ensureDir(CONFIG.outputDir);
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(PATHS.jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(PATHS.mdDir);

  const existingIndex = loadIndex();

  if (existingIndex.size > 0) {
    const counts = trackedDownloadCounts(progress);
    console.log(`Found existing index with ${existingIndex.size} conversations`);
    console.log(`   ${counts.total} tracked downloaded total (${counts.regular} regular, ${counts.projectOnly} project-only)\n`);
  }

  const conversationIndex = await fetchConversationListIncremental(accessToken, existingIndex, progress);

  if (conversationIndex.size === 0) {
    console.log('No conversations found.\n');
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
  }

  console.log('Downloading conversations...\n');

  let conversations = Array.from(conversationIndex.values());
  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  const updateMaxWindow = CONFIG.updateExisting && CONFIG.maxConversations !== null;
  if (updateMaxWindow) {
    const exportedArtifactTimes = collectExportedArtifactTimes();
    const fullStats = updateCatchupStats(conversations, exportedArtifactTimes);
    console.log(
      `Update state: found ${conversations.length} conversations; ${fullStats.current} already downloaded/current; ${fullStats.pending} need download/update`
    );
    conversations = conversations
      .sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a));
    const window = updateMaxDownloadWindow(conversations, exportedArtifactTimes);
    const windowStats = updateCatchupStats(window, exportedArtifactTimes);
    console.log(
      `Update plan: will download ${windowStats.pending} now; scanned ${window.length} latest conversations; ${windowStats.current} already current in safety window`
    );
    conversations = window.filter(conv => conversationNeedsUpdate(conv, exportedArtifactTimes));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;

    if (!updateMaxWindow && CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }
    // 13-char prefix spans the full first UUID segment + dash + start of
    // second segment. 8 chars collided silently when many conversations
    // shared a timestamp-encoded prefix (bulk-archive assigns many IDs in
    // the same second), causing the existence check below to match any
    // collision-sharing file and silently skip all but one.
    const shortId = conv.id.substring(0, 13);

    if (!CONFIG.updateExisting) {
      if (progress.downloadedIds.includes(conv.id)) {
        skipCount++;
        continue;
      }

      const jsonDirExists = fs.existsSync(PATHS.jsonDir);
      if (jsonDirExists) {
        const existingFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId));
        if (existingFiles.length > 0) {
          progress.downloadedIds.push(conv.id);
          saveProgress(progress);
          skipCount++;
          continue;
        }
      }
    }

    const isUpdate = CONFIG.updateExisting && (
      progress.downloadedIds.includes(conv.id) ||
      (fs.existsSync(PATHS.jsonDir) && fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId)).length > 0)
    );

    try {
      await throttle('payload');
      const action = isUpdate ? '~' : '+';
      process.stdout.write(`${progress_display} ${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);
      if (!fullConversation.gizmo_id && (conv.gizmo_id || conv._project_id)) {
        fullConversation.gizmo_id = conv.gizmo_id || conv._project_id;
      }

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [PATHS.jsonDir, PATHS.mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(PATHS.mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, PATHS.filesDir, progress, conv);
        fileCount += fc;
        saveIndex(conversationIndex);
      }

      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);
      saveStatus(progress, { startTime: runStartTime });

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        if (error.cloudflareError) {
          console.log('\n\n  Cloudflare challenge during download. Progress saved.');
          console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
          console.log('   Token is likely fine — wait (CF IP reputation decays over hours) or retry from a different public IP.\n');
        } else {
          console.log('\n\n  Token expired during download. Progress saved.');
          console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
          console.log('   Run again with a fresh token to continue.\n');
        }
        throw error;
      }
      console.log(`error: ${error.message}`);
      verboseLog(`    Failed conversation ID: ${conv.id}`);
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
}

async function exportProjectConversations(accessToken, project, progress) {
  const projectId = project.id;
  const projProgress = progress.projects[projectId];
  if (!projProgress) return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };

  const folderName = sanitizeProjectFolder(project.name);
  const projectDir = path.join(PATHS.projectsDir, folderName);
  const jsonDir = path.join(projectDir, 'json');
  const mdDir = path.join(projectDir, 'markdown');
  const filesDir = path.join(projectDir, 'files');
  const projectConvIndexFile = path.join(projectDir, 'conversation-index.json');

  let conversations = [];
  if (fs.existsSync(projectConvIndexFile)) {
    try {
      conversations = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
    }
  }

  if (conversations.length === 0) {
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
  }

  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(mdDir);

  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    // 13-char prefix — see comment in exportConversations above for rationale.
    const shortId = conv.id.substring(0, 13);

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }

    if (!CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id)) {
      skipCount++;
      continue;
    }

    const isUpdate = CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id);

    try {
      await throttle('payload');
      const action = isUpdate ? '  ~' : '  +';
      process.stdout.write(`${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [jsonDir, mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, filesDir, progress, conv);
        fileCount += fc;
        fs.writeFileSync(projectConvIndexFile, JSON.stringify(conversations, null, 2));
      }

      if (!projProgress.downloadedIds.includes(conv.id)) {
        projProgress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        const label = error.cloudflareError ? 'Cloudflare challenge' : 'Token expired';
        console.log(`\n  ${label} during project "${project.name}" export. Progress saved.`);
        throw error;
      }
      console.log(`error: ${error.message}`);
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
}

function mergeProjectConversationIntoMainIndex(mainIndex, project, conv) {
  const projectId = conv.gizmo_id || project.id;
  const candidate = { ...conv, gizmo_id: projectId, _project_id: project.id };

  if (!mainIndex.has(conv.id)) {
    mainIndex.set(conv.id, candidate);
    return 'added';
  }

  const existing = mainIndex.get(conv.id);
  const updated = { ...existing, ...candidate };
  if (
    existing.update_time !== updated.update_time ||
    existing.title !== updated.title ||
    existing.gizmo_id !== updated.gizmo_id
  ) {
    mainIndex.set(conv.id, updated);
    return 'updated';
  }

  return 'unchanged';
}

async function mergeProjectConversationsIntoMainIndex(projects) {
  const mainIndex = loadIndex();
  let addedCount = 0;
  let updatedCount = 0;

  for (const project of projects) {
    const folderName = sanitizeProjectFolder(project.name);
    const projectConvIndexFile = path.join(PATHS.projectsDir, folderName, 'conversation-index.json');

    if (!fs.existsSync(projectConvIndexFile)) continue;

    let projectConvs;
    try {
      projectConvs = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      verboseLog(`  Warning: could not read project index for "${project.name}", skipping merge`);
      continue;
    }

    for (const conv of projectConvs) {
      const result = mergeProjectConversationIntoMainIndex(mainIndex, project, conv);
      if (result === 'added') addedCount++;
      if (result === 'updated') updatedCount++;
    }
  }

  if (addedCount > 0 || updatedCount > 0) {
    saveIndex(mainIndex);
    console.log(`  Merged ${addedCount} new / ${updatedCount} updated project conversation(s) into main index`);
  } else {
    verboseLog('  No new project conversations to merge into main index');
  }
}

async function mergeProjectConversationPreviewsIntoMainIndex(projects) {
  if (!projectPreviewContainersAvailable(projects)) {
    return false;
  }

  const mainIndex = loadIndex();
  let addedCount = 0;
  let updatedCount = 0;

  for (const project of projects) {
    for (const conv of project._conversationPreviews || []) {
      const result = mergeProjectConversationIntoMainIndex(mainIndex, project, conv);
      if (result === 'added') addedCount++;
      if (result === 'updated') updatedCount++;
    }
  }

  if (addedCount > 0 || updatedCount > 0) {
    saveIndex(mainIndex);
    console.log(`  Merged ${addedCount} new / ${updatedCount} updated project preview conversation(s) into main index`);
  } else {
    verboseLog('  No new project preview conversations to merge into main index');
  }

  return true;
}

function projectPreviewContainersAvailable(projects) {
  return projects.every(project => project._hasConversationPreviewContainer === true);
}

function projectPreviewHorizonClosed(projects, previewLimit) {
  const candidates = Array.from(loadIndex().values());
  for (const project of projects) {
    candidates.push(...(project._conversationPreviews || []));
  }

  if (candidates.length === 0) return true;

  const sorted = candidates
    .slice()
    .sort((a, b) => conversationTimestamp(b) - conversationTimestamp(a));
  const cutoffIndex = Math.min(UPDATE_HORIZON_CAP, sorted.length) - 1;
  const cutoff = conversationTimestamp(sorted[cutoffIndex]);

  for (const project of projects) {
    const previews = project._conversationPreviews || [];
    if (previews.length < previewLimit) continue;
    if (previews.length === 0) continue;

    let oldestPreview = previews[0];
    for (const preview of previews) {
      if (conversationTimestamp(preview) < conversationTimestamp(oldestPreview)) {
        oldestPreview = preview;
      }
    }
    const oldest = conversationTimestamp(oldestPreview);
    if (oldest >= cutoff) return false;
  }

  return true;
}

async function refreshProjectIndexes(accessToken, progress, existingProjects = null) {
  let projects = existingProjects || await fetchProjectList(accessToken, progress);
  if (CONFIG.projFilter) {
    projects = projects.filter(p => CONFIG.projFilter.has(p.id));
  }

  for (const project of projects) {
    const folderName = sanitizeProjectFolder(project.name);
    console.log(`  Refreshing project index: "${project.name}" (${folderName}/)`);
    await fetchProjectConversations(accessToken, project, progress);
  }

  await mergeProjectConversationsIntoMainIndex(projects);
  return projects;
}

async function refreshProjectPreviewIndexes(accessToken, progress) {
  let previewLimit = Math.min(CONFIG.maxConversations, UPDATE_HORIZON_CAP);
  while (previewLimit <= UPDATE_HORIZON_CAP) {
    console.log(`  Fetching project previews: conversations_per_gizmo=${previewLimit}`);
    let projects = await fetchProjectList(accessToken, progress, {
      conversationsPerGizmo: previewLimit,
    });
    if (CONFIG.projFilter) {
      projects = projects.filter(p => CONFIG.projFilter.has(p.id));
    }

    if (!projectPreviewContainersAvailable(projects)) {
      console.log('  Sidebar project conversation previews unavailable; falling back to full project refresh');
      return refreshProjectIndexes(accessToken, progress, projects);
    }

    if (projectPreviewHorizonClosed(projects, previewLimit)) {
      await mergeProjectConversationPreviewsIntoMainIndex(projects);
      return projects;
    }
    if (previewLimit < UPDATE_HORIZON_CAP) {
      const nextPreviewLimit = Math.min(previewLimit + 5, UPDATE_HORIZON_CAP);
      console.log(`  Project preview horizon still open at ${previewLimit}; expanding to ${nextPreviewLimit}`);
      previewLimit = nextPreviewLimit;
    } else {
      break;
    }
  }

  throw new Error(
    'PROJECT_PREVIEW_LIMIT_EXCEEDED: project preview horizon reached 50 in update mode; manual inspection or full refresh is required.'
  );
}

// Scans every JSON file on disk (regular + project dirs) and returns the set
// of conversation IDs actually present.
function collectIdsOnDisk() {
  const onDisk = new Set();
  const scanJsonDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = data.id || data.conversation_id;
        if (id) onDisk.add(id);
      } catch {}
    }
  };
  scanJsonDir(PATHS.jsonDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const projFolder of fs.readdirSync(PATHS.projectsDir)) {
      scanJsonDir(path.join(PATHS.projectsDir, projFolder, 'json'));
    }
  }
  return onDisk;
}

// Returns IDs in progress.downloadedIds that have no corresponding file on disk.
function findSilentlySkippedConversations(progress) {
  const onDisk = collectIdsOnDisk();
  return (progress.downloadedIds || []).filter(id => !onDisk.has(id));
}

// Removes any IDs from progress.downloadedIds (and per-project arrays) that don't have a file
// on disk so the main export loop re-fetches them. Mutates progress; saves to disk.
function refetchMissing(progress) {
  const onDisk = collectIdsOnDisk();

  const topMissing = (progress.downloadedIds || []).filter(id => !onDisk.has(id));
  progress.downloadedIds = (progress.downloadedIds || []).filter(id => onDisk.has(id));

  let projMissingCount = 0;
  if (progress.projects) {
    for (const pid of Object.keys(progress.projects)) {
      const pp = progress.projects[pid];
      if (pp && Array.isArray(pp.downloadedIds)) {
        const before = pp.downloadedIds.length;
        pp.downloadedIds = pp.downloadedIds.filter(id => onDisk.has(id));
        projMissingCount += before - pp.downloadedIds.length;
      }
    }
  }

  const total = topMissing.length + projMissingCount;
  if (total === 0) {
    console.log('  No missing conversations — progress and disk are in sync.\n');
    return 0;
  }
  saveProgress(progress);
  console.log(`  Marked ${total} silently-skipped conversation(s) for re-download.\n`);
  return total;
}

async function runVerify(progress) {
  console.log('=== Verify mode (dry run) ===\n');
  const missing = findSilentlySkippedConversations(progress);
  const index = loadIndex();
  console.log(`Index entries:           ${index.size}`);
  console.log(`Progress "downloaded":   ${(progress.downloadedIds || []).length}`);
  console.log(`Silently skipped:        ${missing.length}`);
  if (missing.length === 0) {
    console.log('\n  ✓ No silent skips detected. Export is clean.\n');
    return;
  }
  console.log('\n  ⚠ Conversation IDs marked downloaded but not present on disk:\n');
  const preview = missing.slice(0, 10);
  for (const id of preview) {
    const entry = index.get(id);
    console.log(`    - ${id}  ${entry?.title ? `"${entry.title.substring(0, 50)}"` : ''}`);
  }
  if (missing.length > 10) console.log(`    ... and ${missing.length - 10} more`);
  console.log('');
}

async function run(accessToken) {
  const progress = loadProgress();
  if (CONFIG.resetPacing) {
    console.log('  Pacing reset: ignoring previous run snapshot (--reset-pacing)');
  } else {
    restorePacingSnapshot(progress.pacing);
  }
  resetSessionPacingStats();
  runStartTime = Date.now();

  // Graceful shutdown: on Ctrl-C, flush progress + status before exiting.
  // Double Ctrl-C bypasses the save and exits immediately. Registered
  // inside run() so the handler closes over `progress`; unregistered in
  // the finally block below so repeated invocations (e.g., e2e tests)
  // don't pile up listeners and trigger MaxListenersExceeded warnings.
  let interrupting = false;
  const sigintHandler = () => {
    if (interrupting) {
      console.log('\nForce-exit.');
      process.exit(130);
    }
    interrupting = true;
    console.log('\n\nInterrupted. Flushing progress before exit...');
    try { saveProgress(progress); } catch {}
    try { saveStatus(progress, { startTime: runStartTime }); } catch {}
    console.log('Saved. Re-run with the same args to resume.');
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigintHandler);
  const unregisterSignals = () => {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigintHandler);
  };

  try {
  console.log('Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`Teams Account ID: ${CONFIG.accountId}`);
  }

  // --verify short-circuits: dry-run report, no network calls.
  if (CONFIG.verifyMode) {
    await runVerify(progress);
    return { verified: true };
  }

  // Refetch-missing runs before the main export loop so the main loop
  // treats the cleared IDs as first-time downloads.
  if (CONFIG.refetchMissing) {
    console.log('Refetch-missing: scanning for silent skips...');
    refetchMissing(progress);
  }

  if (CONFIG.updateExisting) {
    console.log('Update mode: Will re-download existing conversations');
  }
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`Project export: ${CONFIG.projectsOnly ? 'projects only' : 'included'}`);
  }
  if (CONFIG.downloadFiles) {
    console.log('File downloads: enabled');
  }
  if (CONFIG.verbose) {
    console.log('Verbose mode: on');
  }
  if (CONFIG.throttleMs === 0) {
    console.log('Pacing: disabled');
  } else if (typeof CONFIG.throttleMs === 'number' && CONFIG.throttleMs > 0) {
    console.log(`Pacing: adaptive (user floor: ${CONFIG.throttleMs / 1000}s)`);
  } else {
    console.log('Pacing: adaptive (payload 2s / indexing 5s baseline, climbs on 429s)');
  }
  if (CONFIG.maxConversations !== null) console.log(`Max this session: ${CONFIG.maxConversations} conversations`);
  if (CONFIG.convFilter) console.log(`Conversation filter: ${[...CONFIG.convFilter].join(', ')}`);
  if (CONFIG.projFilter) console.log(`Project filter: ${[...CONFIG.projFilter].join(', ')}`);
  console.log('');

  const summary = {
    regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
    projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
  };

  try {
    if (usesUnifiedProjectUpdateWindow()) {
      console.log('=== Project Index Refresh ===\n');
      await refreshProjectPreviewIndexes(accessToken, progress);
      console.log('');
    }

    if (!CONFIG.projectsOnly) {
      console.log('=== Regular Conversations ===\n');
      summary.regular = await exportConversations(accessToken, progress);
    }

    if ((CONFIG.includeProjects || CONFIG.projectsOnly) && !usesUnifiedProjectUpdateWindow()) {
      console.log('\n=== Project Conversations ===\n');

      let projects = await fetchProjectList(accessToken, progress);
      if (CONFIG.projFilter) {
        projects = projects.filter(p => CONFIG.projFilter.has(p.id));
      }
      summary.projects.count = projects.length;

      for (const project of projects) {
        const folderName = sanitizeProjectFolder(project.name);
        console.log(`\nProject: "${project.name}" (${folderName}/)`);

        const conversations = await fetchProjectConversations(accessToken, project, progress);
        if (!conversations || conversations.length === 0) {
          console.log('  No conversations.');
        } else {
          console.log(`  ${conversations.length} conversations`);

          const result = await exportProjectConversations(accessToken, project, progress);
          summary.projects.conversations += (result.success + result.skip + result.update + result.error);
          summary.projects.success += result.success;
          summary.projects.skip += result.skip;
          summary.projects.update += result.update;
          summary.projects.error += result.error;
          summary.projects.fileCount += result.fileCount;
        }

        if (CONFIG.downloadFiles && project.files && project.files.length > 0) {
          console.log(`  Downloading ${project.files.length} project-level files...`);
          const fc = await downloadProjectFiles(accessToken, project, progress);
          summary.projects.fileCount += fc;
        }
      }

      await mergeProjectConversationsIntoMainIndex(projects);
    }

    if (CONFIG.downloadFiles) {
      const retried = await retryPendingFiles(accessToken, progress);
      if (retried > 0) summary.retriedFiles = retried;
      const failedCount = Object.keys(progress.failedFileIds).length;
      if (failedCount > 0) summary.failedFiles = failedCount;
    }
  } catch (error) {
    if (error.authError) {
      printSummary(summary);
      process.exit(1);
    }
    throw error;
  }

  summary.elapsedMs = Date.now() - runStartTime;
  summary.pacingStats = getPacingStats();
  printSummary(summary);
  return summary;
  } finally {
    unregisterSignals();
    if (CONFIG.useBrowserFetch) {
      try { await require('./browser-fetch').closeBrowser(); } catch {}
    }
  }
}

function printSummary(summary) {
  if (!CONFIG.showSummary) return;

  const r = summary.regular;
  const p = summary.projects;

  const downloaded = r.success + r.update + p.success + p.update;
  const skipped = r.skip + p.skip;
  const errors = r.error + p.error;
  const files = r.fileCount + p.fileCount;
  const projects = p.count;

  console.log('\n' + '='.repeat(50));
  console.log('  Export Complete!');
  console.log('='.repeat(50));

  // Conversations line (always shown)
  let convParts = [`${downloaded} downloaded`];
  if (skipped > 0) convParts.push(`${skipped} skipped`);
  if (errors > 0) convParts.push(`${errors} errors`);
  console.log(`\n  Conversations:  ${convParts.join('    ')}`);

  // Projects line (only if projects were included)
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`  Projects:       ${projects} found`);
  }

  // Files line (only if file downloads were enabled and any were downloaded, retried, or failed)
  if (CONFIG.downloadFiles && (files > 0 || summary.retriedFiles > 0 || summary.failedFiles > 0)) {
    let fileParts = [`${files} downloaded`];
    if (summary.retriedFiles > 0) fileParts.push(`${summary.retriedFiles} retried`);
    if (summary.failedFiles > 0) fileParts.push(`${summary.failedFiles} permanently failed`);
    console.log(`  Files:          ${fileParts.join('    ')}`);
  }

  if (typeof summary.elapsedMs === 'number') {
    const mins = summary.elapsedMs / 60000;
    const elapsed = mins >= 60
      ? `${(mins / 60).toFixed(1)}h`
      : `${mins.toFixed(1)}m`;
    const pace = downloaded > 0 && mins > 0
      ? `${(downloaded / mins).toFixed(1)} conv/min`
      : null;
    const paceSuffix = pace ? `    (${pace})` : '';
    console.log(`  Elapsed:        ${elapsed}${paceSuffix}`);
  }

  if (summary.pacingStats) {
    const s = summary.pacingStats;
    console.log(`  Pacing:         final ${(s.currentInterval / 1000).toFixed(1)}s    peak ${(s.peakInterval / 1000).toFixed(1)}s`);
  }

  console.log(`\n  Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

module.exports = { exportConversations, exportProjectConversations, run, printSummary, collectIdsOnDisk, findSilentlySkippedConversations, refetchMissing, conversationTimestamp };
