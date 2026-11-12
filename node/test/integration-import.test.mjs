import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createIntegrationService } from '../src/integration/service.mjs';
import { copyTree, treeRevision, inspectTree } from '../src/integration/storage.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sdk-import-transaction-'));
  const root = path.join(directory, 'workspaces'), sdk = path.join(directory, 'vendor'), pluginsRoot = path.join(directory, 'plugins');
  await mkdir(sdk);
  await writeFile(path.join(sdk, 'api.h'), 'header');
  await writeFile(path.join(sdk, 'vendor.dll'), Buffer.from([0, 1, 2, 3]));
  const service = await createIntegrationService({ root, pluginsRoot, ...options });
  t.after(async () => {
    await service.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sdk-import-transaction-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, sdk, pluginsRoot, service };
}
const manifest = { api_version:1,id:'import-test',name:'Import test',version:'1.0.0',entry:'adapter.mjs',config_fields:[],
  streams:[{id:'rgb',name:'camera',kind:'camera',dtype:'uint8',shape:[1,1,3],sample_rate:0}] };
const adapter = 'export function createAdapter(){return {probe(){return {ok:true}},async start(){},async stop(){}}}';

test('import preserves libraries and headers and reserves room for generated files at source limits', async t => {
  const { root, sdk, service } = await fixture(t, { importLimits: { files:2,bytes:10,fileBytes:6 } });
  const imported = await service.importDirectory({ path:sdk });
  assert.deepEqual(imported.files.map(f=>f.path), ['api.h','vendor.dll']);
  assert.equal(imported.bytes, 10);
  assert.deepEqual(await readFile(path.join(root, imported.id, 'draft/sdk/vendor.dll')), Buffer.from([0,1,2,3]));
  await service.writeDraft({workspace_id:imported.id,path:'plugin.json',content:JSON.stringify(manifest)});
  const drafted=await service.writeDraft({workspace_id:imported.id,path:'adapter.mjs',content:adapter});
  const tree=await inspectTree(path.join(root, imported.id, 'draft'));
  assert.equal(drafted.draft.revision,treeRevision(tree.files));
  assert.equal(drafted.draft.files.length,2);
  assert.ok((await service.test({workspace_id:imported.id})).test.passed);
  assert.equal((await service.install({workspace_id:imported.id})).installed.plugin_id,manifest.id);
});

test('disk-space failure occurs before creating or copying a partial workspace', async t => {
  let copies=0;
  const { root,sdk,service }=await fixture(t,{checkDiskSpace:async()=>{throw new Error('磁盘空间不足 fixture')},copySdkTree:async()=>{copies++}});
  await assert.rejects(service.importDirectory({path:sdk}),/磁盘空间不足/);
  assert.equal(copies,0);assert.deepEqual(await readdir(root),[]);
});

test('failed copy cleans only its staging directory and releases import lock for retry', async t => {
  let fail=false;
  const {root,sdk,service}=await fixture(t,{copySdkTree:async(source,destination,files,options)=>{
    if(fail){await writeFile(path.join(destination,'partial.bin'),'partial');throw Object.assign(new Error('fixture'),{code:'ENOSPC'})}
    return copyTree(source,destination,files,options);
  }});
  const existing=await service.importDirectory({path:sdk});fail=true;
  await assert.rejects(service.importDirectory({path:sdk}),/空间不足/);
  assert.deepEqual(await readdir(root),[existing.id]);
  assert.equal((await service.status({workspace_id:existing.id})).status,'imported');
  fail=false;
  const next=await service.importDirectory({path:sdk});assert.notEqual(next.id,existing.id);
  assert.equal((await service.list()).workspaces.length,2);
});

test('in-progress import stays unpublished, rejects overlap, and shutdown aborts and cleans it', async t => {
  const entered=Promise.withResolvers();
  const {root,sdk,service}=await fixture(t,{copySdkTree:async(_source,destination,_files,{signal})=>{
    await writeFile(path.join(destination,'partial.bin'),'partial');entered.resolve();
    await new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
  }});
  const importing=service.importDirectory({path:sdk});const failed=assert.rejects(importing,/取消/);
  await entered.promise;
  assert.equal((await service.list()).workspaces.length,0);
  await assert.rejects(service.importDirectory({path:sdk}),/正在导入/);
  await service.close();await failed;assert.deepEqual(await readdir(root),[]);
});

test('lightweight draft edits do not bypass full SDK revalidation during install', async t=>{
  const {root,sdk,service}=await fixture(t);
  const state=await service.importDirectory({path:sdk});
  await service.writeDraft({workspace_id:state.id,path:'plugin.json',content:JSON.stringify(manifest)});
  await service.writeDraft({workspace_id:state.id,path:'adapter.mjs',content:adapter});
  assert.ok((await service.test({workspace_id:state.id})).test.passed);
  await writeFile(path.join(root,state.id,'draft/sdk/vendor.dll'),'changed');
  await assert.rejects(service.install({workspace_id:state.id}),/重新测试|先测试/);
});

test('installation checks target disk and cleans incomplete staging without changing installed version', async t=>{
  let failSpace=false,failCopy=false;
  const {sdk,pluginsRoot,service}=await fixture(t,{checkDiskSpace:async()=>{if(failSpace)throw new Error('磁盘空间不足 fixture')},
    copySdkTree:async(source,destination,files,options)=>{
      if(failCopy){await mkdir(destination,{recursive:true});await writeFile(path.join(destination,'partial.bin'),'p');throw Object.assign(new Error('fixture'),{code:'ENOSPC'})}
      return copyTree(source,destination,files,options);
    }});
  const state=await service.importDirectory({path:sdk});
  await service.writeDraft({workspace_id:state.id,path:'plugin.json',content:JSON.stringify(manifest)});
  await service.writeDraft({workspace_id:state.id,path:'adapter.mjs',content:adapter});
  await service.test({workspace_id:state.id});await service.install({workspace_id:state.id});
  failSpace=true;await assert.rejects(service.install({workspace_id:state.id}),/空间不足/);
  failSpace=false;failCopy=true;await assert.rejects(service.install({workspace_id:state.id}),/空间不足/);
  assert.ok(!(await readdir(pluginsRoot)).some(name=>name.startsWith('.staging-')));
  assert.equal(JSON.parse(await readFile(path.join(pluginsRoot,manifest.id,'plugin.json'),'utf8')).version,manifest.version);
});
