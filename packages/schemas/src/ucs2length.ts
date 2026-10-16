// String length in Unicode code points, as JSON Schema's maxLength requires.
// Same algorithm as ajv/dist/runtime/ucs2length, inlined so the package has no runtime dependencies.
export function ucs2length(str: string): number {
  const len = str.length
  let length = 0
  let pos = 0
  while (pos < len) {
    length++
    const value = str.charCodeAt(pos++)
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      if ((str.charCodeAt(pos) & 0xfc00) === 0xdc00) pos++
    }
  }
  return length
}
