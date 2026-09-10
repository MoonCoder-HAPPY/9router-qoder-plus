import qoderProvider from "open-sse/providers/registry/qoder.js";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const qoderPublicModelKv = makeKv("qoderPublicModels");
const qoderPublicDefaultsKv = makeKv("qoderPublicModelDefaults");

function cleanModelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePublicId(value) {
  return cleanModelId(value);
}

function defaultPublicId(model) {
  return normalizePublicId(model?.name || model?.displayName || model?.display_name || model?.id);
}

function staticQoderModels() {
  return (qoderProvider.models || [])
    .map((model) => ({
      id: cleanModelId(model.id),
      name: defaultPublicId(model),
    }))
    .filter((model) => model.id && model.name);
}

function allDefaultModels(savedDefaults = {}) {
  const out = new Map();
  for (const model of staticQoderModels()) {
    out.set(model.id, { internalId: model.id, publicId: model.name });
  }
  for (const [internalId, mapping] of Object.entries(savedDefaults || {})) {
    const publicId = normalizePublicId(mapping?.publicId);
    if (internalId && publicId) out.set(internalId, { internalId, publicId });
  }
  return out;
}

function normalizeInternalModel(model) {
  const internalId = cleanModelId(model?.internalId || model?.qoderInternalId || model?.id);
  if (!internalId) return null;
  const fallbackPublicId = defaultPublicId(model) || internalId;
  return { ...model, internalId, fallbackPublicId };
}

async function getSavedMappings() {
  return await qoderPublicModelKv.getAll();
}

async function getSavedDefaults() {
  return await qoderPublicDefaultsKv.getAll();
}

export async function getQoderPublicModelMappings() {
  return await getSavedMappings();
}

export async function setQoderPublicModelMapping(internalId, publicId) {
  const cleanInternalId = cleanModelId(internalId);
  const cleanPublicId = normalizePublicId(publicId);
  if (!cleanInternalId) throw new Error("Qoder internal model id is required");
  if (!cleanPublicId) throw new Error("Qoder public model id is required");

  const mappings = await getSavedMappings();
  const defaults = await getSavedDefaults();
  for (const [otherInternalId, mapping] of Object.entries(mappings)) {
    const otherPublicId = normalizePublicId(mapping?.publicId);
    if (otherInternalId !== cleanInternalId && otherPublicId === cleanPublicId) {
      throw new Error(`Qoder public model id "${cleanPublicId}" is already used by "${otherInternalId}"`);
    }
  }
  for (const [otherInternalId, mapping] of Object.entries(defaults)) {
    if (mappings[otherInternalId]) continue;
    const otherPublicId = normalizePublicId(mapping?.publicId);
    if (otherInternalId !== cleanInternalId && otherPublicId === cleanPublicId) {
      throw new Error(`Qoder public model id "${cleanPublicId}" is already used by "${otherInternalId}"`);
    }
  }
  for (const [otherInternalId, mapping] of allDefaultModels(defaults).entries()) {
    if (mappings[otherInternalId]) continue;
    const otherPublicId = normalizePublicId(mapping?.publicId);
    if (otherInternalId !== cleanInternalId && otherPublicId === cleanPublicId) {
      throw new Error(`Qoder public model id "${cleanPublicId}" is already used by "${otherInternalId}"`);
    }
  }

  const value = {
    internalId: cleanInternalId,
    publicId: cleanPublicId,
    updatedAt: new Date().toISOString(),
  };
  await qoderPublicModelKv.set(cleanInternalId, value);
  return value;
}

export async function decorateQoderModelsForPublic(models) {
  const mappings = await getSavedMappings();
  const existingDefaults = await getSavedDefaults();
  const seenPublicIds = new Set();
  const out = [];

  for (const model of models || []) {
    const normalized = normalizeInternalModel(model);
    if (!normalized) continue;
    if (
      normalized.fallbackPublicId
      && normalizePublicId(existingDefaults[normalized.internalId]?.publicId) !== normalized.fallbackPublicId
    ) {
      await qoderPublicDefaultsKv.set(normalized.internalId, {
        internalId: normalized.internalId,
        publicId: normalized.fallbackPublicId,
        updatedAt: new Date().toISOString(),
      });
    }
    const savedPublicId = normalizePublicId(mappings[normalized.internalId]?.publicId);
    let publicId = savedPublicId || normalized.fallbackPublicId;
    if (seenPublicIds.has(publicId)) {
      publicId = `${publicId} (${normalized.internalId})`;
    }
    seenPublicIds.add(publicId);
    out.push({
      ...model,
      id: publicId,
      name: publicId,
      publicId,
      displayName: publicId,
      internalId: normalized.internalId,
      qoderInternalId: normalized.internalId,
      defaultPublicId: normalized.fallbackPublicId,
    });
  }

  return out;
}

export async function resolveQoderPublicModelId(publicId) {
  const cleanPublicId = normalizePublicId(publicId);
  if (!cleanPublicId || cleanPublicId.includes("/")) return null;

  const mappings = await getSavedMappings();
  for (const [internalId, mapping] of Object.entries(mappings)) {
    if (normalizePublicId(mapping?.publicId) === cleanPublicId) return internalId;
  }

  const defaults = await getSavedDefaults();
  for (const [internalId, mapping] of Object.entries(defaults)) {
    if (normalizePublicId(mapping?.publicId) === cleanPublicId) return internalId;
  }

  for (const model of staticQoderModels()) {
    if (model.name === cleanPublicId) return model.id;
  }

  for (const internalId of allDefaultModels(defaults).keys()) {
    if (internalId === cleanPublicId) return internalId;
  }

  return null;
}
