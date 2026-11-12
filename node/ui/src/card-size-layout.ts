export type CardSizeKind = "camera" | "microphone" | "sensor";
export type CardSize = { width: number; height: number };
export type SavedCardSize = Partial<CardSize> & { fullHeight?: boolean };
export type SavedCardSizes = Record<string, SavedCardSize>;
export interface CardSizeDescriptor {
  id: string;
  kind: CardSizeKind;
  defaultWidth: number;
  defaultHeight: number;
  maxWidth: number;
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
}
export const CARD_SIZE_MAX_HEIGHT = 2000;
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
export const boundCardSize = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const minimum = (kind: CardSizeKind) => kind === "camera" ? 220 : kind === "microphone" ? 140 : 200;

export function cardSizeLimits(card: CardSizeDescriptor) {
  const maxWidth = finitePositive(card.maxWidth) ? Math.max(1, Math.min(10000, card.maxWidth)) : 1000;
  const minWidth = Math.min(maxWidth, finitePositive(card.minWidth) ? card.minWidth : minimum(card.kind));
  const maxHeight = finitePositive(card.maxHeight) ? Math.min(CARD_SIZE_MAX_HEIGHT, card.maxHeight) : CARD_SIZE_MAX_HEIGHT;
  const minHeight = Math.min(maxHeight, finitePositive(card.minHeight) ? card.minHeight : minimum(card.kind));
  return { minWidth, maxWidth, minHeight, maxHeight };
}

/** Only persisted user choices are stored. Responsive defaults remain responsive until edited. */
export function normalizeCardSizes(value: unknown): SavedCardSizes {
  const result: SavedCardSizes = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const envelope = value as { version?: unknown; cards?: unknown };
  if (envelope.version !== 1 || !envelope.cards || typeof envelope.cards !== "object" || Array.isArray(envelope.cards)) return result;
  for (const [id, candidate] of Object.entries(envelope.cards).slice(0, 512)) {
    if (!id || id.length > 300 || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const source = candidate as SavedCardSize, entry: SavedCardSize = {};
    if (finitePositive(source.width) && source.width <= 10000) entry.width = source.width;
    if (finitePositive(source.height) && source.height <= CARD_SIZE_MAX_HEIGHT) entry.height = source.height;
    if (source.fullHeight === true) entry.fullHeight = true;
    if (entry.width !== undefined || entry.height !== undefined || entry.fullHeight) result[id] = entry;
  }
  return result;
}

export function resolveCardSize(card: CardSizeDescriptor, saved?: SavedCardSize) {
  const limits = cardSizeLimits(card);
  const preferredWidth = finitePositive(saved?.width) ? saved.width : finitePositive(card.defaultWidth) ? card.defaultWidth : minimum(card.kind);
  const preferredHeight = saved?.fullHeight ? limits.maxHeight : finitePositive(saved?.height) ? saved.height : finitePositive(card.defaultHeight) ? card.defaultHeight : minimum(card.kind);
  return {
    ...limits,
    width: boundCardSize(preferredWidth, limits.minWidth, limits.maxWidth),
    height: boundCardSize(preferredHeight, limits.minHeight, limits.maxHeight),
    preferredWidth, preferredHeight,
    fullHeight: saved?.fullHeight === true,
    customized: saved?.width !== undefined || saved?.height !== undefined || saved?.fullHeight === true,
    customizedWidth: saved?.width !== undefined, customizedHeight: saved?.height !== undefined || saved?.fullHeight === true,
  };
}
