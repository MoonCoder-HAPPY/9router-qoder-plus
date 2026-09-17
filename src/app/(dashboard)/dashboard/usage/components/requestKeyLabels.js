export function getRequestKeyName(detail, translate = value => value) {
  if (detail.apiKeyId === null && detail.apiKeyName === null) return translate("No API Key");
  return detail.apiKeyName || translate("Unknown API Key");
}

export function getRequestKeyOptions(apiKeys, translate = value => value) {
  return apiKeys.map(({ id, name }) => {
    const label = name || translate("Unknown API Key");
    const sameName = apiKeys.filter(key => (key.name || translate("Unknown API Key")) === label);
    if (sameName.length === 1) return { id, label };
    let length = Math.min(8, id.length);
    while (length < id.length && sameName.some(key => key.id !== id && key.id.slice(0, length) === id.slice(0, length))) length += 1;
    return { id, label: `${label} (${id.slice(0, length)})` };
  });
}
