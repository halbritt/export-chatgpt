'use strict';

const path = require('path');

describe('exporter', () => {
  let CONFIG, printSummary;

  beforeEach(() => {
    jest.resetModules();
    ({ CONFIG } = require('../../lib/config'));
    CONFIG.outputDir = '/tmp/test-exports';
    CONFIG.includeProjects = true;
    CONFIG.downloadFiles = true;
    CONFIG.showSummary = true;
    ({ printSummary } = require('../../lib/exporter'));
  });

  function makeSummary(overrides = {}) {
    return {
      regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, ...overrides.regular },
      projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0, ...overrides.projects },
    };
  }

  describe('printSummary', () => {
    let logSpy;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    test('prints "Export Complete!" banner', () => {
      printSummary(makeSummary());
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Export Complete!');
    });

    test('shows conversation download count', () => {
      printSummary(makeSummary({ regular: { success: 10, update: 2 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('12 downloaded');
    });

    test('combines regular and project conversation counts', () => {
      printSummary(makeSummary({
        regular: { success: 10, update: 2 },
        projects: { success: 5, update: 1 },
      }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('18 downloaded');
    });

    test('shows skipped count when non-zero', () => {
      printSummary(makeSummary({ regular: { skip: 5 }, projects: { skip: 3 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('8 skipped');
    });

    test('omits skipped count when zero', () => {
      printSummary(makeSummary({ regular: { success: 10 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).not.toContain('skipped');
    });

    test('shows error count when non-zero', () => {
      printSummary(makeSummary({ regular: { error: 3 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('3 errors');
    });

    test('omits error count when zero', () => {
      printSummary(makeSummary({ regular: { success: 10 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).not.toContain('errors');
    });

    test('shows project count when projects included', () => {
      CONFIG.includeProjects = true;
      printSummary(makeSummary({ projects: { count: 5 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('5 found');
    });

    test('hides project count when projects not included', () => {
      CONFIG.includeProjects = false;
      CONFIG.projectsOnly = false;
      printSummary(makeSummary({ projects: { count: 5 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).not.toContain('found');
    });

    test('shows file count when files downloaded', () => {
      printSummary(makeSummary({ regular: { fileCount: 15 }, projects: { fileCount: 5 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('20 downloaded');
      expect(output).toContain('Files:');
    });

    test('hides file line when no files downloaded', () => {
      printSummary(makeSummary());
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).not.toContain('Files:');
    });

    test('hides file line when downloads disabled', () => {
      CONFIG.downloadFiles = false;
      printSummary(makeSummary({ regular: { fileCount: 10 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).not.toContain('Files:');
    });

    test('shows output directory', () => {
      printSummary(makeSummary());
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Output directory:');
      expect(output).toContain(path.resolve('/tmp/test-exports'));
    });

    test('suppressed when showSummary is false', () => {
      CONFIG.showSummary = false;
      printSummary(makeSummary({ regular: { success: 100 } }));
      expect(logSpy).not.toHaveBeenCalled();
    });

    test('shows permanently failed count when present', () => {
      const s = makeSummary({ regular: { fileCount: 10 } });
      s.failedFiles = 5;
      printSummary(s);
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('5 permanently failed');
      expect(output).toContain('Files:');
    });

    test('shows Files line when only failed files exist', () => {
      const s = makeSummary();
      s.failedFiles = 3;
      printSummary(s);
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Files:');
      expect(output).toContain('0 downloaded');
      expect(output).toContain('3 permanently failed');
    });

    test('shows projects line when projectsOnly is true', () => {
      CONFIG.includeProjects = false;
      CONFIG.projectsOnly = true;
      printSummary(makeSummary({ projects: { count: 2 } }));
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('2 found');
    });
  });

  describe('update max ordering', () => {
    let fs, os, tmpDir, PATHS, initPaths, fetchConversation;

    function makeConv(id, update_time) {
      return { id, title: `Chat ${id}`, create_time: 1700000000, update_time };
    }

    async function loadExporterWithIndex(conversations) {
      jest.resetModules();
      fs = require('fs');
      os = require('os');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-update-test-'));

      fetchConversation = jest.fn(async (_accessToken, id) => makeConv(id, 1700000000));
      jest.doMock('../../lib/api', () => ({
        fetchConversation: fetchConversation,
        fetchConversationListIncremental: jest.fn(async () => (
          new Map(conversations.map(conv => [conv.id, conv]))
        )),
        fetchProjectList: jest.fn(),
        fetchProjectConversations: jest.fn(),
      }));
      jest.doMock('../../lib/downloader', () => ({
        downloadConversationFiles: jest.fn(async () => 0),
        downloadProjectFiles: jest.fn(async () => 0),
        retryPendingFiles: jest.fn(async () => 0),
      }));

      ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
      CONFIG.outputDir = tmpDir;
      CONFIG.exportFormat = 'json';
      CONFIG.downloadFiles = false;
      CONFIG.includeProjects = false;
      CONFIG.projectsOnly = false;
      CONFIG.showSummary = false;
      CONFIG.throttleMs = 0;
      initPaths();

      return require('../../lib/exporter');
    }

    afterEach(() => {
      jest.restoreAllMocks();
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('conversationTimestamp supports number, numeric string, and ISO string', async () => {
      const { conversationTimestamp } = await loadExporterWithIndex([]);

      expect(conversationTimestamp({ update_time: 1700000000 })).toBe(1700000000);
      expect(conversationTimestamp({ update_time: '1700000001' })).toBe(1700000001);
      expect(conversationTimestamp({ update_time: '2023-11-14T22:13:22.000Z' })).toBe(1700000002);
    });

    test('update with max exports the freshest conversations by update_time', async () => {
      const { exportConversations } = await loadExporterWithIndex([
        makeConv('old', 100),
        makeConv('fresh', '2023-11-14T22:13:22.000Z'),
        makeConv('middle', '1700000001'),
      ]);
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 2;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      fs.writeFileSync(path.join(PATHS.jsonDir, 'middle.json'), JSON.stringify(makeConv('middle', '1700000001')));
      fs.writeFileSync(path.join(PATHS.jsonDir, 'old.json'), JSON.stringify(makeConv('old', 100)));

      await exportConversations('token', { downloadedIds: ['old', 'fresh', 'middle'] });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['fresh']);
    });

    test('update with max expands download window while the boundary conversation needs update', async () => {
      const conversations = Array.from({ length: 21 }, (_, i) => makeConv(`conv-${i}`, 2000 - i));
      const { exportConversations } = await loadExporterWithIndex(conversations);
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 10;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      for (const conv of conversations.slice(0, 10)) {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${conv.id}.json`), JSON.stringify(conv));
      }
      fs.writeFileSync(path.join(PATHS.jsonDir, 'conv-19.json'), JSON.stringify(makeConv('conv-19', 2000 - 19)));
      fs.writeFileSync(path.join(PATHS.jsonDir, 'conv-20.json'), JSON.stringify(makeConv('conv-20', 2000 - 20)));
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      await exportConversations('token', { downloadedIds: conversations.map(c => c.id) });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(
        conversations.slice(10, 19).map(c => c.id)
      );
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Update state: found 21 conversations; 12 already downloaded/current; 9 need download/update');
      expect(output).toContain('Update window has pending conversation at rank 19; expanding to 15 conversations');
      expect(output).toContain('Update window has pending conversation at rank 19; expanding to 20 conversations');
      expect(output).toContain('Update tail closed at 20: no pending conversations in next 1 checked');
      expect(output).toContain('Update plan: will download 9 now; scanned 20 latest conversations; 11 already current in safety window');
    });

    test('update with max expands past an initially clean chunk when a later checked rank is pending', async () => {
      const conversations = Array.from({ length: 55 }, (_, i) => makeConv(`conv-${i}`, 3000 - i));
      const { exportConversations } = await loadExporterWithIndex(conversations);
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 10;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      for (const conv of conversations.slice(0, 50)) {
        if (conv.id === 'conv-43') continue;
        fs.writeFileSync(path.join(PATHS.jsonDir, `${conv.id}.json`), JSON.stringify(conv));
      }
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      await exportConversations('token', { downloadedIds: conversations.map(c => c.id) });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['conv-43']);
      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Update window has pending conversation at rank 44; expanding to 15 conversations');
      expect(output).toContain('Update window has pending conversation at rank 44; expanding to 45 conversations');
      expect(output).toContain('Update tail closed at 45: no pending conversations in next 5 checked');
      expect(output).toContain('Update plan: will download 1 now; scanned 45 latest conversations; 44 already current in safety window');
    });

    test('update with format both re-downloads when markdown is missing even if json is current', async () => {
      const { exportConversations } = await loadExporterWithIndex([
        makeConv('chat-1', 1000),
      ]);
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 10;
      CONFIG.exportFormat = 'both';
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      fs.writeFileSync(path.join(PATHS.jsonDir, 'chat-1.json'), JSON.stringify(makeConv('chat-1', 1000)));

      await exportConversations('token', { downloadedIds: ['chat-1'] });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['chat-1']);
    });

    test('update with max downloads pending rank 50 when the index ends at rank 50', async () => {
      const conversations = Array.from({ length: 50 }, (_, i) => makeConv(`conv-${i}`, 3000 - i));
      const { exportConversations } = await loadExporterWithIndex(conversations);
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 10;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      for (const conv of conversations.slice(0, 49)) {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${conv.id}.json`), JSON.stringify(conv));
      }

      await exportConversations('token', { downloadedIds: conversations.map(c => c.id) });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['conv-49']);
    });

    test('max without update preserves existing insertion-order resume behavior', async () => {
      const { exportConversations } = await loadExporterWithIndex([
        makeConv('old', 100),
        makeConv('fresh', '2023-11-14T22:13:22.000Z'),
        makeConv('middle', '1700000001'),
      ]);
      CONFIG.updateExisting = false;
      CONFIG.maxConversations = 2;

      await exportConversations('token', { downloadedIds: [] });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['old', 'fresh']);
    });

    test('existing index log reports regular plus project tracked download counts', async () => {
      const { exportConversations } = await loadExporterWithIndex([
        makeConv('regular', 100),
      ]);
      fs.writeFileSync(PATHS.indexFile, JSON.stringify([makeConv('regular', 100)]));
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      await exportConversations('token', {
        downloadedIds: ['regular', 'shared'],
        projects: {
          'proj-1': { downloadedIds: ['project-only', 'shared'] },
          'proj-2': { downloadedIds: ['project-two'] },
        },
      });

      const output = logSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Found existing index with 1 conversations');
      expect(output).toContain('4 tracked downloaded total (2 regular, 2 project-only)');
      expect(output).not.toContain('Already downloaded: 2');
    });
  });

  describe('unified project update window', () => {
    let fs, os, tmpDir, PATHS, initPaths, CONFIG;
    let fetchConversation, fetchProjectList, fetchProjectConversations;

    function makeFullConversation(id, title) {
      return {
        id,
        title,
        create_time: '2026-05-18T10:00:00Z',
        update_time: '2026-05-19T10:00:00Z',
        mapping: {
          root: { parent: null, children: ['m1'], message: null },
          m1: {
            parent: 'root',
            children: [],
            message: {
              content: { content_type: 'text', parts: ['Hello'] },
              author: { role: 'user' },
              metadata: {},
            },
          },
        },
      };
    }

    async function loadExporterForUnified(projects) {
      jest.resetModules();
      fs = require('fs');
      os = require('os');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-unified-test-'));

      fetchConversation = jest.fn(async (_accessToken, id) => makeFullConversation(id, `Full ${id}`));
      fetchProjectList = jest.fn(async (_accessToken, _progress, options) => (
        typeof projects === 'function' ? projects(options.conversationsPerGizmo) : projects
      ));
      fetchProjectConversations = jest.fn(async () => []);

      jest.doMock('../../lib/api', () => ({
        fetchConversation,
        fetchConversationListIncremental: jest.fn(async (_accessToken, existingIndex) => existingIndex),
        fetchProjectList,
        fetchProjectConversations,
      }));
      jest.doMock('../../lib/downloader', () => ({
        downloadConversationFiles: jest.fn(async () => 0),
        downloadProjectFiles: jest.fn(async () => 0),
        retryPendingFiles: jest.fn(async () => 0),
      }));

      ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
      CONFIG.outputDir = tmpDir;
      CONFIG.exportFormat = 'both';
      CONFIG.downloadFiles = false;
      CONFIG.includeProjects = true;
      CONFIG.projectsOnly = false;
      CONFIG.updateExisting = true;
      CONFIG.maxConversations = 2;
      CONFIG.showSummary = false;
      CONFIG.throttleMs = 0;
      initPaths();

      jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(process.stdout, 'write').mockImplementation();

      return require('../../lib/exporter');
    }

    function projectWithPreview(count, oldestTimestamp, overrides = {}) {
      const previews = Array.from({ length: count }, (_, i) => ({
        id: `${overrides.id || 'proj-1'}-conv-${i}`,
        title: `Preview ${i}`,
        create_time: 1700000000 - i,
        update_time: i === count - 1 ? oldestTimestamp : 1700001000 - i,
        gizmo_id: overrides.id || 'proj-1',
      }));
      return {
        id: overrides.id || 'proj-1',
        name: overrides.name || 'Project One',
        _hasConversationPreviewContainer: true,
        _conversationPreviews: previews,
      };
    }

    afterEach(() => {
      jest.restoreAllMocks();
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('merges sidebar preview candidates into the main index without project conversation refresh', async () => {
      const { run } = await loadExporterForUnified([
        {
          id: 'proj-1',
          name: 'Project One',
          _hasConversationPreviewContainer: true,
          _conversationPreviews: [
            {
              id: 'project-fresh',
              title: 'Project Fresh',
              create_time: '2026-05-18T10:00:00Z',
              update_time: '2026-05-19T10:00:00Z',
              gizmo_id: 'proj-1',
            },
          ],
        },
      ]);

      await run('token');

      const index = JSON.parse(fs.readFileSync(PATHS.indexFile, 'utf8'));
      expect(index.map(c => c.id)).toContain('project-fresh');
      expect(fetchProjectList).toHaveBeenCalledWith(
        'token',
        expect.anything(),
        { conversationsPerGizmo: 2 }
      );
      expect(fetchProjectConversations).not.toHaveBeenCalled();
      expect(fetchConversation).toHaveBeenCalledWith('token', 'project-fresh');
    });

    test('falls back to full project refresh when sidebar preview container is malformed', async () => {
      const { run } = await loadExporterForUnified([
        { id: 'proj-1', name: 'Project One', _conversationPreviews: [] },
      ]);

      await run('token');

      expect(fetchProjectConversations).toHaveBeenCalledWith(
        'token',
        expect.objectContaining({ id: 'proj-1' }),
        expect.anything()
      );
    });

    test('does not fall back when sidebar preview container exists with an empty items array', async () => {
      const { run } = await loadExporterForUnified([
        {
          id: 'proj-1',
          name: 'Project One',
          _hasConversationPreviewContainer: true,
          _conversationPreviews: [],
        },
      ]);

      await run('token');

      expect(fetchProjectConversations).not.toHaveBeenCalled();
    });

    test('propagates project id from sidebar candidate into markdown frontmatter', async () => {
      const { run } = await loadExporterForUnified([
        {
          id: 'proj-1',
          name: 'Project One',
          _hasConversationPreviewContainer: true,
          _conversationPreviews: [
            {
              id: 'project-fresh',
              title: 'Project Fresh',
              create_time: '2026-05-18T10:00:00Z',
              update_time: '2026-05-19T10:00:00Z',
              gizmo_id: 'proj-1',
            },
          ],
        },
      ]);

      await run('token');

      const markdownFiles = fs.readdirSync(PATHS.mdDir).filter(f => f.endsWith('.md'));
      const markdown = fs.readFileSync(path.join(PATHS.mdDir, markdownFiles[0]), 'utf8');
      expect(markdown).toContain('project_id: proj-1');
    });

    test('expands project previews until the oldest full page item is older than the global cutoff', async () => {
      const { run } = await loadExporterForUnified((k) => [
        projectWithPreview(k, k === 10 ? 1700000900 : 1),
      ]);
      CONFIG.maxConversations = 10;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      fs.mkdirSync(PATHS.mdDir, { recursive: true });
      const regular = Array.from({ length: 50 }, (_, i) => ({
        id: `regular-cutoff-${i}`,
        title: `Regular ${i}`,
        create_time: 1700000800 - i,
        update_time: 1700000800 - i,
      }));
      fs.writeFileSync(PATHS.indexFile, JSON.stringify(regular, null, 2));
      for (const conv of regular) {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${conv.id}.json`), JSON.stringify(conv));
        fs.writeFileSync(path.join(PATHS.mdDir, `${conv.id}.md`), [
          `id: ${conv.id}`,
          `update_time: ${conv.update_time}`,
          '',
        ].join('\n'));
      }

      await run('token');

      expect(fetchProjectList.mock.calls.map(call => call[2].conversationsPerGizmo)).toEqual([10, 15]);
      expect(fetchProjectConversations).not.toHaveBeenCalled();
    });

    test('project preview horizon is proven against the top 50 even when max is 10', async () => {
      const { run } = await loadExporterForUnified((k) => [
        projectWithPreview(k, k === 10 ? 981 : 1),
      ]);
      CONFIG.maxConversations = 10;
      fs.mkdirSync(PATHS.jsonDir, { recursive: true });
      fs.mkdirSync(PATHS.mdDir, { recursive: true });
      const regular = Array.from({ length: 50 }, (_, i) => ({
        id: `regular-${i}`,
        title: `Regular ${i}`,
        create_time: 1000 - i,
        update_time: 1000 - i,
      }));
      fs.writeFileSync(PATHS.indexFile, JSON.stringify(regular, null, 2));
      for (const conv of regular) {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${conv.id}.json`), JSON.stringify(conv));
        fs.writeFileSync(path.join(PATHS.mdDir, `${conv.id}.md`), [
          `id: ${conv.id}`,
          `update_time: ${conv.update_time}`,
          '',
        ].join('\n'));
      }

      await run('token');

      expect(fetchProjectList.mock.calls.map(call => call[2].conversationsPerGizmo)).toEqual([10, 15]);
    });

    test('project preview update with max above 50 starts at the proof cap instead of failing immediately', async () => {
      const { run } = await loadExporterForUnified([
        {
          id: 'proj-1',
          name: 'Project One',
          _hasConversationPreviewContainer: true,
          _conversationPreviews: [],
        },
      ]);
      CONFIG.maxConversations = 51;

      await run('token');

      expect(fetchProjectList.mock.calls.map(call => call[2].conversationsPerGizmo)).toEqual([50]);
    });

    test('aborts before downloads when project preview horizon remains open at 50', async () => {
      const { run } = await loadExporterForUnified((k) => [
        {
          ...projectWithPreview(k, 1700001000),
          _conversationPreviews: Array.from({ length: k }, (_, i) => ({
            id: `proj-1-conv-${i}`,
            title: `Preview ${i}`,
            create_time: 1700000000,
            update_time: 1700001000,
            gizmo_id: 'proj-1',
          })),
        },
      ]);
      CONFIG.maxConversations = 10;

      await expect(run('token')).rejects.toThrow(/PROJECT_PREVIEW_LIMIT_EXCEEDED/);

      expect(fetchProjectList.mock.calls.map(call => call[2].conversationsPerGizmo)).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50]);
      expect(fetchConversation).not.toHaveBeenCalled();
    });
  });
});
