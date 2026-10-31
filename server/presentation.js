const trafficSources = ['auto', 'ga4', 'cloudflare', 'vercel'];
const presets = ['generic', 'lonelysky'];
const gameEvents = [
  ['game_ready', '游戏就绪'],
  ['play_milestone', '航行里程碑'],
  ['planet_publish', '公开家园'],
  ['planet_visit', '拜访星球'],
  ['postcard_share', '分享明信片'],
  ['postcard_download_requested', '请求下载明信片'],
  ['flight_time', '有效航行时长上报', 'seconds'],
  ['flight_distance', '航程上报', 'game_units'],
  ['coflight_connected', '同航连接建立'],
  ['planet_letter_confirmed', '短笺确认（含恢复）'],
  ['planet_reply_sent', '星球回复已寄出'],
  ['link_copied', '链接已复制'],
  ['travel_completed', '跳转抵达'],
];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only these presentation fields may be sent to the authenticated browser.
// Never include the environment or a rejected configuration value in warnings.
export function presentationFrom(env = {}) {
  const warnings = [];
  const requestedSource = env.DASHBOARD_PRIMARY_SOURCE || 'auto';
  const primarySource = trafficSources.includes(requestedSource) ? requestedSource : 'auto';
  if (requestedSource !== primarySource) warnings.push('总览主数据源配置无效，已使用自动选择。');
  const requestedPreset = env.DASHBOARD_EVENT_PRESET || 'generic';
  const preset = presets.includes(requestedPreset) ? requestedPreset : 'generic';
  if (requestedPreset !== preset) warnings.push('事件预设配置无效，已使用通用事件展示。');
  const definitions = Object.create(null);
  if (preset === 'lonelysky') gameEvents.forEach(([name, label, valueUnit], order) => {
    definitions[name] = valueUnit ? {label, order, valueUnit} : {label, order};
  });
  if (env.DASHBOARD_EVENT_DEFINITIONS_JSON) {
    try {
      const custom = JSON.parse(env.DASHBOARD_EVENT_DEFINITIONS_JSON);
      if (!record(custom)) throw new Error('Expected event definitions object');
      let invalid = false;
      for (const [name, definition] of Object.entries(custom)) {
        if (!name.trim() || !record(definition)
          || (Object.hasOwn(definition, 'label') && typeof definition.label !== 'string')
          || (Object.hasOwn(definition, 'group') && typeof definition.group !== 'string')
          || (Object.hasOwn(definition, 'order') && !Number.isFinite(definition.order))
          || (Object.hasOwn(definition, 'hidden') && typeof definition.hidden !== 'boolean')
          || (Object.hasOwn(definition, 'valueUnit') && !['seconds','game_units'].includes(definition.valueUnit))) {
          invalid = true;
          continue;
        }
        const display = {...definitions[name]};
        for (const key of ['label', 'group', 'order', 'hidden', 'valueUnit']) {
          if (Object.hasOwn(definition, key)) display[key] = definition[key];
        }
        definitions[name] = display;
      }
      if (invalid) warnings.push('部分事件定义格式无效，已忽略这些项。');
    } catch {
      warnings.push('事件定义 JSON 无法读取，已使用预设或原始事件名称。');
    }
  }
  return {primarySource, events: {preset, definitions}, warnings};
}
