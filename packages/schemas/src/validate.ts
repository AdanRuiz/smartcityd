import * as compiled from './generated/validators.js'
import type {
  AppContent,
  CityContent,
  DatasetContent,
  ObservationContent,
  ReleaseContent,
  ReportContent,
  ReportUpdateContent,
  RolesContent,
  SnapshotContent,
  SourceContent,
  StateContent,
} from './generated/types.js'
import { KIND, isSystemKind, type SystemKind } from './kinds.js'
import { checkTags } from './tags.js'

export interface ContentByKind {
  [KIND.CITY]: CityContent
  [KIND.DATASET]: DatasetContent
  [KIND.SOURCE]: SourceContent
  [KIND.APP]: AppContent
  [KIND.ROLES]: RolesContent
  [KIND.STATE]: StateContent
  [KIND.RELEASE]: ReleaseContent
  [KIND.OBSERVATION]: ObservationContent
  [KIND.REPORT]: ReportContent
  [KIND.SNAPSHOT]: SnapshotContent
  [KIND.REPORT_UPDATE]: ReportUpdateContent
  [KIND.LIVE]: StateContent
}

export type ValidationResult<T> = { ok: true; content: T } | { ok: false; errors: string[] }

interface CompiledValidator {
  (data: unknown): boolean
  errors?: { instancePath: string; message?: string }[] | null
}

const validators: Record<SystemKind, CompiledValidator> = {
  [KIND.CITY]: compiled.city,
  [KIND.DATASET]: compiled.dataset,
  [KIND.SOURCE]: compiled.source,
  [KIND.APP]: compiled.app,
  [KIND.ROLES]: compiled.roles,
  [KIND.STATE]: compiled.state,
  [KIND.RELEASE]: compiled.release,
  [KIND.OBSERVATION]: compiled.observation,
  [KIND.REPORT]: compiled.report,
  [KIND.SNAPSHOT]: compiled.snapshot,
  [KIND.REPORT_UPDATE]: compiled.report_update,
  [KIND.LIVE]: compiled.state,
}

// EVT-4: at most 6 decimals. JSON Schema's multipleOf is unreliable for this with floats.
function coordinateErrors(content: { loc?: unknown; bbox?: unknown; obs?: unknown }): string[] {
  const coords = [content.loc, content.bbox]
  if (Array.isArray(content.obs)) for (const o of content.obs) coords.push((o as { loc?: unknown }).loc)
  const ok = coords.flat().every((n) => typeof n !== 'number' || Number(n.toFixed(6)) === n)
  return ok ? [] : ['coordinates must have at most 6 decimals']
}

/** Validates an already parsed `content` against the schema of its kind. */
export function validateContent<K extends SystemKind>(kind: K, content: unknown): ValidationResult<ContentByKind[K]> {
  const validate = validators[kind]
  if (!validate(content)) {
    const errors = (validate.errors ?? []).map((e) => `content${e.instancePath} ${e.message ?? 'is invalid'}`)
    return { ok: false, errors }
  }
  const errors = coordinateErrors(content as object)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, content: content as ContentByKind[K] }
}

export interface EventToValidate {
  kind: number
  tags: readonly (readonly string[])[]
  content: string
}

/**
 * Validates content and mandatory tags of a system kind (EVT-7, DATA-5). Does not verify `id` or `sig`.
 * Other kinds (NIP-09 deletions, NIP-65 lists…) have no schema here: check `isSystemKind` first.
 */
export function validateEvent(event: EventToValidate): ValidationResult<ContentByKind[SystemKind]> {
  if (!isSystemKind(event.kind)) return { ok: false, errors: [`kind ${event.kind} has no schema`] }
  let parsed: unknown
  try {
    parsed = JSON.parse(event.content)
  } catch {
    return { ok: false, errors: ['content is not valid JSON'] }
  }
  const result = validateContent(event.kind, parsed)
  if (!result.ok) return result
  const errors = checkTags(event.kind, event.tags, result.content)
  return errors.length > 0 ? { ok: false, errors } : result
}

type Value = number | string | boolean

/**
 * EVT-8: checks observation/state `values` against the `fields` of the dataset they refer to.
 * Returns the list of problems; empty when the values are fine.
 */
export function checkValues(fields: DatasetContent['fields'], values: Record<string, Value>): string[] {
  const errors: string[] = []
  for (const [name, value] of Object.entries(values)) {
    const field = Object.hasOwn(fields, name) ? fields[name] : undefined
    if (!field) {
      errors.push(`"${name}" is not a field of the dataset`)
      continue
    }
    const typeOk =
      field.type === 'integer'
        ? Number.isInteger(value)
        : field.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === field.type
    if (!typeOk) errors.push(`"${name}" must be of type ${field.type}`)
    else if (typeof value === 'number' && field.min !== undefined && value < field.min) {
      errors.push(`"${name}" is below the minimum ${field.min}`)
    } else if (typeof value === 'number' && field.max !== undefined && value > field.max) {
      errors.push(`"${name}" is above the maximum ${field.max}`)
    } else if (field.enum && !field.enum.includes(value)) {
      errors.push(`"${name}" is not one of the allowed values`)
    }
  }
  return errors
}
