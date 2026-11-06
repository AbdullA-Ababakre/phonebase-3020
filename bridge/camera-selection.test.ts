import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraPolicy, configurationWithCameraFocus, selectCameraCaptures } from './camera-selection';
const devices = [{id:'01',capturePriority:90},{id:'04',capturePriority:100},{id:'05'},{id:'06'}];
const config = {devices, videoCapture:{maximumActiveCameras:2,focusDeviceId:'01'}};
const ids = (items: {id:string}[]) => items.map(device=>device.id);
test('focus changes retain protected capture and stop only the previous optional stream',()=>{
 assert.deepEqual(ids(selectCameraCaptures(devices,cameraPolicy(config))),['04','01']);
 const next=configurationWithCameraFocus(config,'05',ids(devices),[]);
 assert.deepEqual(ids(selectCameraCaptures(devices,cameraPolicy(next))),['04','05']);
 assert.equal(config.videoCapture.focusDeviceId,'01');
});
test('unlimited stations keep all captures and missing devices do not consume slots',()=>{
 assert.equal(selectCameraCaptures(devices,{}).length,4);
 assert.deepEqual(ids(selectCameraCaptures(devices.filter(d=>d.id!=='01'),cameraPolicy(config))),['04','05']);
});
test('video switching refuses to interrupt motion on the camera being replaced',()=>{
 assert.throws(()=>configurationWithCameraFocus(config,'05',ids(devices),['01']),/executing/);
 assert.doesNotThrow(()=>configurationWithCameraFocus(config,'05',ids(devices),['04']));
});
test('invalid focus, limits, duplicate identities and protected-slot eviction are rejected',()=>{
 assert.throws(()=>configurationWithCameraFocus(config,'99',ids(devices),[]),/connected/);
 assert.throws(()=>cameraPolicy({...config,videoCapture:{maximumActiveCameras:0}}),/Invalid/);
 assert.throws(()=>selectCameraCaptures([...devices,devices[0]],{}),/Duplicate/);
 assert.throws(()=>selectCameraCaptures(devices,{maximumActiveCameras:1,focusDeviceId:'01'}),/protected/);
});

test('opening a protected camera never steals the optional camera from another phone',()=>{
 const focused=configurationWithCameraFocus(config,'05',ids(devices),[]);
 assert.equal(configurationWithCameraFocus(focused,'04',ids(devices),[]),focused);
 assert.deepEqual(ids(selectCameraCaptures(devices,cameraPolicy(focused))),['04','05']);
});
