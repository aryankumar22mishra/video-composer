import test from 'node:test'
import assert from 'node:assert/strict'
import { resizeTimelineClip } from '../state/timelineResize.js'
const composition = { duration: 7, tracks: [{ clips: [{ id: 'a', duration: 5, speed: 2, sourceStart: 2, startTime: 0 }, { id: 'b', duration: 2, startTime: 5 }] }], texts: [] }
test('start edge trims source at playback speed and ripples subsequent clips without mutating history', () => {
 const next = resizeTimelineClip(composition, 'a', 'start', 1, 20)
 assert.equal(next.tracks[0].clips[0].sourceStart, 4)
 assert.equal(next.tracks[0].clips[0].duration, 4)
 assert.equal(next.tracks[0].clips[1].startTime, 4)
 assert.equal(composition.duration, 7)
})
test('edges respect source bounds and minimum duration', () => {
 assert.equal(resizeTimelineClip(composition, 'a', 'end', 100, 20).tracks[0].clips[0].duration, 9)
 assert.equal(resizeTimelineClip(composition, 'a', 'end', -100, 20).tracks[0].clips[0].duration, .25)
 assert.equal(resizeTimelineClip(composition, 'a', 'start', -100, 20).tracks[0].clips[0].sourceStart, 0)
})
test('image end can extend without a video source bound', () => {
 assert.equal(resizeTimelineClip(composition, 'a', 'end', 10).duration, 17)
})
