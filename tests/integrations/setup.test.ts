import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFolders, findNode, readJsonObject } from '../../integrations/claude-code/setup.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-setup-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const refused = (p: string) => `Refusing ${p}: choose the folder that holds company work, not the whole home or drive.`;

it('parseFolders resolves existing folders separated by ;', () => {
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, 'b'));
  expect(parseFolders(` ${path.join(dir, 'a')} ; ${path.join(dir, 'b')};`, path.join(dir, 'home'))).toEqual([path.join(dir, 'a'), path.join(dir, 'b')]);
});

it('parseFolders refuses no folders, the home folder, a drive root and missing folders', () => {
  expect(() => parseFolders('', dir)).toThrow(/^No folders given\.$/);
  expect(() => parseFolders(' ; ', dir)).toThrow(/^No folders given\.$/);
  expect(() => parseFolders(dir + path.sep, dir)).toThrow(refused(dir));
  const root = path.parse(dir).root;
  expect(() => parseFolders(root, dir)).toThrow(refused(root));
  expect(() => parseFolders(path.join(dir, 'nope'), path.join(dir, 'home'))).toThrow(`Folder not found: ${path.join(dir, 'nope')}`);
});

it('findNode takes the node on PATH (preferring .exe on Windows), else this process', () => {
  const plain = path.join(dir, 'node');
  const exe = path.join(dir, 'node.exe');
  fs.writeFileSync(plain, '');
  fs.writeFileSync(exe, '');
  expect(findNode(() => [plain, exe], 'win32')).toBe(exe);
  expect(findNode(() => [plain, exe], 'linux')).toBe(plain);
  expect(findNode(() => [path.join(dir, 'missing')], 'linux')).toBe(process.execPath);
  expect(findNode(() => [dir], 'linux')).toBe(process.execPath);
  expect(findNode(() => [], 'linux')).toBe(process.execPath);
});

it('readJsonObject strips a leading BOM', () => {
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '\uFEFF{"model":"opus"}');
  expect(readJsonObject(f)).toEqual({ model: 'opus' });
});
