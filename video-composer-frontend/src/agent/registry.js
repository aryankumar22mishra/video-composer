import definitions from './toolRegistry.json' with { type: 'json' }

export const TOOL_REGISTRY = Object.fromEntries(definitions.map((tool) => [tool.name, tool]))

export function validateSchema(value, schema, path = 'arguments') {
  const kind = schema.type
  const valid = {
    object: value !== null && typeof value === 'object' && !Array.isArray(value),
    array: Array.isArray(value), string: typeof value === 'string', boolean: typeof value === 'boolean',
    number: typeof value === 'number' && Number.isFinite(value), integer: Number.isInteger(value),
  }[kind]
  if (!valid) throw new Error(`${path} must be ${kind}.`)
  if (kind === 'object') {
    const properties = schema.properties || {}
    if (Object.keys(value).some((key) => !Object.hasOwn(properties, key)) || (schema.required || []).some((key) => !Object.hasOwn(value, key))) {
      throw new Error(`${path} has missing or unexpected fields.`)
    }
    for (const [key, item] of Object.entries(value)) validateSchema(item, properties[key], `${path}.${key}`)
  } else if (kind === 'array') {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems || 1000)) throw new Error(`${path} has an invalid length.`)
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) throw new Error(`${path} must be unique.`)
    value.forEach((item) => validateSchema(item, schema.items, path))
  } else if (kind === 'string') {
    if (value.trim().length < (schema.minLength || 0) || value.length > (schema.maxLength || 5000)) throw new Error(`${path} has an invalid length.`)
  } else if (kind === 'number' || kind === 'integer') {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.multipleOf && value % schema.multipleOf)) {
      throw new Error(`${path} is outside the supported range.`)
    }
  }
}

export function validateCall(call, availableTools) {
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some((key) => !['id', 'name', 'arguments', 'depends_on'].includes(key))) throw new Error('Invalid tool call.')
  if (typeof call.id !== 'string' || !call.id.length || call.id.length > 100) throw new Error('Tool calls require stable IDs.')
  const tool = Object.hasOwn(TOOL_REGISTRY, call.name) ? TOOL_REGISTRY[call.name] : null
  if (!tool) throw new Error('Unknown tool. Only registered tools may execute.')
  const capability = availableTools.find((item) => item.name === call.name)
  if (!capability?.available) throw new Error(capability?.unavailable_reason || `${call.name} is unavailable.`)
  validateSchema(call.arguments, tool.arguments)
  if (call.depends_on !== undefined && (!Array.isArray(call.depends_on) || call.depends_on.length > 24 || call.depends_on.some((id) => typeof id !== 'string'))) throw new Error('Invalid tool dependencies.')
  return tool
}
