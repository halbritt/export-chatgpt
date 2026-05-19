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

      await exportConversations('token', { downloadedIds: ['old', 'fresh', 'middle'] });

      expect(fetchConversation.mock.calls.map(call => call[1])).toEqual(['fresh', 'middle']);
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
  });
});
