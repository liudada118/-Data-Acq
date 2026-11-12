import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureEngine } from '../src/capture/engine.mjs';
import { readRecords } from '../src/exports/reader.mjs';

// Marker structure fixture only. No camera, DLL, production plugin or entropy-decoding claim.
const JPEG = Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,
  255,218,0,12,3,1,0,2,0,3,0,0,63,0,42,255,0,42,255,217]);
const PAYLOADS = [JPEG, Buffer.concat([JPEG, Buffer.alloc(19)]), JPEG.subarray(0, -2)];
const manifest = { api_version: 1, id: 'capture-mjpeg-fixture', name: 'Test only variable JPEG and RGB', version: '1.0.0', entry: 'adapter.mjs',
  streams: [
    { id: 'jpeg', name: 'Test compressed camera', kind: 'camera', encoding: 'mjpeg', dtype: 'uint8', shape: [2,3,3], sample_rate: 30 },
    { id: 'rgb', name: 'Test legacy RGB', kind: 'camera', dtype: 'uint8', shape: [2,3,3], sample_rate: 30 },
  ], config_fields: [{ key: 'commands', label: 'Test-only command path', type: 'string', required: true }] };
const source = `import {readFile} from 'node:fs/promises';
export function createAdapter({config,emit}) {
 let timer, busy=false, last=-1;
 return {start() {timer=setInterval(async()=>{
   if(busy)return; busy=true;
   try {
     const command=JSON.parse(await readFile(config.commands,'utf8'));
     if(command.revision===last)return; last=command.revision;
     for(const frame of command.frames) {
       emit({stream_id:'jpeg',payload:Buffer.from(frame.jpeg,'base64'),sequence:frame.sequence,device_time_ns:frame.time});
       emit({stream_id:'rgb',payload:Buffer.alloc(18,frame.rgb),sequence:frame.sequence,device_time_ns:frame.time});
     }
   } catch(error) { if(!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
   finally {busy=false;}
 },15);},stop(){clearInterval(timer);}};
}`;
async function until(check, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) { if (Date.now() - start > timeout) throw new Error('Fixture delivery timed out'); await delay(20); }
}
async function collect(folder, stream) { const result=[]; for await(const record of readRecords(folder, stream)) result.push(record); return result; }

test('CaptureEngine stores original variable JPEGs plus RGB and resets source-quality summaries for each recording', async t => {
  const prefix=path.join(os.tmpdir(),'mjpeg-capture-fixture-'), directory=await mkdtemp(prefix);
  const pluginRoot=path.join(directory,'plugins'), packageDir=path.join(pluginRoot,manifest.id), dataDir=path.join(directory,'sessions');
  const commands=path.join(directory,'commands.json');
  await mkdir(packageDir,{recursive:true});
  await writeFile(path.join(packageDir,'plugin.json'),JSON.stringify(manifest));
  await writeFile(path.join(packageDir,'adapter.mjs'),source);
  const engine=new CaptureEngine({dataDir,pluginRoot,sdkPath:false});
  t.after(async()=> { await engine.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(prefix))); await rm(directory,{recursive:true,force:true}); });
  await engine.init();
  const connection=await engine.pluginConnect({plugin_id:manifest.id,instance_id:'isolated',config:{commands}});
  let revision=0, delivered=0;
  const deliver=async (sequences, variants=[])=> {
    const frames=sequences.map((sequence,index)=>({sequence,time:String(9007199254740993n+BigInt(index)),
      jpeg:PAYLOADS[variants[index]??0].toString('base64'),rgb:40+index}));
    await writeFile(commands,JSON.stringify({revision:++revision,frames}));
    delivered+=frames.length*2;
    await until(async()=> (await engine.pluginCatalog()).instances[0].received_records===delivered);
    return frames;
  };
  await deliver(['1','20']); // Preview-only history must not contaminate a recording's counters.
  const started=await engine.start({name:'Isolated MJPEG recording test',device_ids:connection.stream_ids});
  const frames=await deliver(['100','101','104','104','103'],[0,1,2,0,0]);
  const finished=await engine.stop();
  assert.equal(finished.status,'complete'); assert.equal(finished.dropped_records,0);
  const folder=path.join(dataDir,started.id), metadata=(await readFile(path.join(folder,'plugin-frames.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const stream of finished.streams) {
    const rows=await collect(folder,stream), jpeg=stream.encoding==='mjpeg';
    assert.equal(rows.length,5); assert.equal(stream.samples,5);
    assert.equal(stream.payload_bytes,rows.reduce((total,row)=>total+row.payload.length,0));
    const expected=frames.map(frame=>jpeg?Buffer.from(frame.jpeg,'base64'):Buffer.alloc(18,frame.rgb));
    assert.deepEqual(rows.map(row=>row.payload),expected,'writer must preserve every byte, including bad JPEG and trailing padding');
    assert.equal(stream.quality.scope,'recorded-frames'); assert.equal(stream.quality.observed_frames,5);
    assert.equal(stream.quality.source_missing_frames,'2'); assert.equal(stream.quality.source_gap_events,1);
    assert.equal(stream.quality.source_duplicates,1); assert.equal(stream.quality.source_reversals,1);
    assert.equal(stream.quality.invalid_jpeg_frames,jpeg?1:0); assert.equal(stream.quality.jpeg_warning_frames,jpeg?1:0);
    assert.equal(stream.quality.jpeg_decode_verified,false); assert.deepEqual(stream.metadata.quality,stream.quality);
    const sidecar=metadata.filter(row=>row.stream_id===stream.id);
    assert.equal(sidecar.length,rows.length);
    assert.deepEqual(sidecar.map(row=>row.source_sequence),frames.map(frame=>frame.sequence));
    assert.deepEqual(sidecar.map(row=>row.sequence),rows.map(row=>row.sequence.toString()));
    assert.deepEqual(sidecar.map(row=>row.source_device_time_ns),frames.map(frame=>frame.time));
    assert.ok(rows.every((row,index)=>index===0 || row.hostNs>=rows[index-1].hostNs));
  }
  assert.deepEqual(await engine.getSession(started.id),finished,'final quality is persisted, not only returned in memory');

  await deliver(['500']);
  await engine.start({device_ids:connection.stream_ids});
  await deliver(['501','502']);
  const second=await engine.stop();
  for(const stream of second.streams) {
    assert.equal(stream.quality.observed_frames,2); assert.equal(stream.quality.source_missing_frames,'0');
    assert.equal(stream.quality.source_duplicates,0); assert.equal(stream.quality.invalid_jpeg_frames,0);
  }

  await engine.start({device_ids:connection.stream_ids});
  await deliver([undefined,undefined]);
  const unknown=await engine.stop();
  for(const stream of unknown.streams) {
    assert.equal(stream.quality.source_sequence_status,'unknown'); assert.equal(stream.quality.source_missing_frames,null);
    assert.equal(stream.quality.source_gap_events,null); assert.equal(stream.quality.observed_frames,2);
  }
  await engine.pluginDisconnect({instance_id:'isolated'});
});
