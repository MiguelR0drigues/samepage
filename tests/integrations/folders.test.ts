import { expect, it } from 'vitest';
import { isCompanyFolder } from '../../integrations/claude-code/lib/folders.mjs';

const W = ['C:\\PROJECTS\\Scooli'];

it('matches subfolders on win32, ignoring drive-letter case', () => {
  expect(isCompanyFolder('c:\\PROJECTS\\Scooli\\web-app', W, 'win32')).toBe(true);
  expect(isCompanyFolder('C:\\PROJECTS\\Scooli', W, 'win32')).toBe(true);
});

it('matches mixed separators', () => {
  expect(isCompanyFolder('C:/PROJECTS/Scooli', W, 'win32')).toBe(true);
  expect(isCompanyFolder('C:/PROJECTS/Scooli/web-app', W, 'win32')).toBe(true);
  expect(isCompanyFolder('C:\\PROJECTS\\Scooli\\web-app', ['C:/PROJECTS/Scooli'], 'win32')).toBe(true);
});

it('does not match a sibling that shares a prefix', () => {
  expect(isCompanyFolder('C:\\PROJECTS\\ScooliOld', W, 'win32')).toBe(false);
});

it('is case-insensitive on darwin but not on linux', () => {
  expect(isCompanyFolder('/Users/a/scooli/x', ['/Users/a/Scooli'], 'darwin')).toBe(true);
  expect(isCompanyFolder('/Users/a/scooli/x', ['/Users/a/Scooli'], 'linux')).toBe(false);
});

it('is false with no folders', () => {
  expect(isCompanyFolder('C:\\PROJECTS\\Scooli', [], 'win32')).toBe(false);
});
