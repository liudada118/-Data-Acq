import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import koffi from 'koffi';
import { safeRelative, MAX_FRAME_BYTES } from './contract.mjs';

// Native code runs in the disposable plugin process, never in the renderer.
// This API is a path/lifetime guard, not an OS sandbox for arbitrary adapters.
export function createManagedNative({ directory }) {
  const root = path.resolve(directory, 'sdk');
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const libraries = new Map();
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('Native SDK host is closed'); };
  const helpers = ['struct', 'pack', 'union', 'array', 'opaque', 'pointer', 'out', 'inout', 'proto',
    'register', 'unregister', 'as', 'decode', 'encode', 'sizeof', 'alignof', 'alias', 'type', 'enumeration'];
  const ffi = Object.freeze(Object.fromEntries(helpers.map(name => [name, koffi[name]])));

  async function load(relative) {
    assertOpen();
    safeRelative(relative);
    if (!/\.(dll|so(?:\.\d+)*|dylib)$/i.test(relative)) throw new Error('Native SDK requires a shared library in sdk/');
    const filename = path.resolve(root, relative);
    const [actualRoot, actualFile, info] = await Promise.all([realpath(root), realpath(filename), lstat(filename)]);
    if (pathKey(actualRoot) !== pathKey(root) || pathKey(actualFile) !== pathKey(filename) || !pathKey(actualFile).startsWith(pathKey(root) + path.sep) || !info.isFile() || info.isSymbolicLink()) {
      throw new Error('Native SDK library escapes imported sdk/ directory');
    }
    assertOpen();
    const key = pathKey(actualFile);
    if (libraries.has(key)) return libraries.get(key).api;
    let library;
    try { library = koffi.load(actualFile); }
    catch (cause) { throw new Error(`无法加载 SDK 动态库 ${relative}（${process.platform}/${process.arch}）：请检查位数和随附依赖。${cause.message}`, { cause }); }
    const api = Object.freeze({
      func(...declaration) {
        assertOpen();
        const fn = library.func(...declaration);
        const wrapped = (...args) => { assertOpen(); return fn(...args); };
        wrapped.async = (...args) => { assertOpen(); return fn.async(...args); };
        return wrapped;
      },
    });
    // Retain until process exit: unloading a DLL with an SDK thread/callback or
    // Koffi async call still in flight can crash. Adapter.stop releases handles.
    libraries.set(key, { library, api });
    return api;
  }

  return {
    api: Object.freeze({
      version: koffi.version, platform: process.platform, arch: process.arch, ffi, load,
      copy(pointer, byteLength) {
        assertOpen();
        if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_FRAME_BYTES) throw new Error('Native frame copy must be between 1 byte and 32 MiB');
        if (typeof pointer !== 'bigint' || pointer <= 0n) throw new Error('Native frame pointer is null or invalid');
        // Electron forbids external ArrayBuffers: koffi.view aborts its Node
        // process before JS can catch the error. decode copies native bytes into
        // a V8-owned Uint8Array; Buffer can share that owned allocation safely.
        const copied = koffi.decode(pointer, 'uint8_t', byteLength);
        return Buffer.from(copied.buffer, copied.byteOffset, copied.byteLength);
      },
    }),
    close() { closed = true; },
  };
}
