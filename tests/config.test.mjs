import test from 'node:test';
import assert from 'node:assert/strict';
import {configFrom} from '../server/config.js';

test('presentation defaults to generic events and automatic traffic source', () => {
  const config = configFrom();
  assert.equal(config.primarySource, 'auto');
  assert.equal(config.eventConfig.preset, 'generic');
  assert.deepEqual(Object.keys(config.eventConfig.definitions), []);
  assert.deepEqual(config.presentationWarnings, []);
});

test('event definitions override the optional preset and publish only display fields', () => {
  const config = configFrom({
    DASHBOARD_PRIMARY_SOURCE: 'cloudflare',
    DASHBOARD_EVENT_PRESET: 'lonelysky',
    DASHBOARD_EVENT_DEFINITIONS_JSON: JSON.stringify({
      game_ready: {label: '开始体验', group: '互动', order: 2, privateKey: 'fixture-secret'},
      download: {label: '下载', order: 1},
      page_view: {hidden: true},
    }),
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
  });
  assert.equal(config.primarySource, 'cloudflare');
  assert.deepEqual(config.eventConfig.definitions.game_ready, {label: '开始体验', group: '互动', order: 2});
  assert.equal(config.eventConfig.definitions.play_milestone.label, '航行里程碑');
  assert.equal(config.eventConfig.definitions.download.label, '下载');
  assert.equal(config.eventConfig.definitions.page_view.hidden, true);
  assert.doesNotMatch(JSON.stringify(config.eventConfig), /fixture-secret|fixture-google-secret/);
});

test('invalid display configuration falls back with safe warnings and keeps valid definitions', () => {
  const config = configFrom({
    DASHBOARD_PRIMARY_SOURCE: 'fixture-private-source',
    DASHBOARD_EVENT_PRESET: 'fixture-private-preset',
    DASHBOARD_EVENT_DEFINITIONS_JSON: JSON.stringify({
      download: {label: '下载', order: -1},
      sign_up: {hidden: 'false'},
      purchase: {order: '1'},
      bad: null,
    }),
  });
  assert.equal(config.primarySource, 'auto');
  assert.equal(config.eventConfig.preset, 'generic');
  assert.deepEqual(Object.keys(config.eventConfig.definitions), ['download']);
  assert.equal(config.presentationWarnings.length, 3);
  assert.doesNotMatch(JSON.stringify(config.presentationWarnings), /fixture-private/);
  for (const raw of ['{fixture-private-json', 'null', '[]', '42']) {
    const broken = configFrom({DASHBOARD_EVENT_PRESET:'lonelysky', DASHBOARD_EVENT_DEFINITIONS_JSON:raw});
    assert.equal(broken.eventConfig.definitions.game_ready.label, '游戏就绪');
    assert.equal(broken.presentationWarnings.length, 1);
    assert.doesNotMatch(JSON.stringify(broken.presentationWarnings), /fixture-private-json/);
  }
});

test('event names resembling object properties cannot change the definitions prototype', () => {
  const config = configFrom({DASHBOARD_EVENT_DEFINITIONS_JSON:'{"__proto__":{"label":"自定义事件"},"constructor":{"hidden":true}}'});
  assert.equal(Object.getPrototypeOf(config.eventConfig.definitions), null);
  assert.equal(Object.hasOwn(config.eventConfig.definitions, '__proto__'), true);
  assert.equal(config.eventConfig.definitions.__proto__.label, '自定义事件');
  assert.equal(config.eventConfig.definitions.constructor.hidden, true);
});
