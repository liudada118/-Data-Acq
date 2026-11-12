import assert from 'node:assert/strict';

// Resolve the public mapping independently of the production filename generator.
// The archive Map retains its real ZIP names; no old-name aliases are inserted.
export function packageFileMap(files) {
  const report = JSON.parse(files.get('export_report.json'));
  assert.ok(Array.isArray(report.file_mapping), 'package publishes its filename mapping');
  return report.file_mapping;
}

export function packagePath(files, original) {
  const mapping = packageFileMap(files);
  const exact = mapping.filter(item => item.original_file === original);
  assert.ok(exact.length <= 1, `one mapping for ${original}`);
  if (exact.length) return exact[0].file;
  const directory = mapping.filter(item => item.original_file.endsWith('/') && original.startsWith(item.original_file))
    .sort((a, b) => b.original_file.length - a.original_file.length)[0];
  return directory ? directory.file + original.slice(directory.original_file.length) : original;
}

export function packageEntry(files, original) { return files.get(packagePath(files, original)); }
export function hasPackageEntry(files, original) { return files.has(packagePath(files, original)); }
