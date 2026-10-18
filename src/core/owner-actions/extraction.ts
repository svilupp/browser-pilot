/** Finite JSON projection; callers supply selectors and scalar fields, never executable code. */
export interface OwnerExtractField {
  selector: string;
  source: 'text' | 'value' | 'attribute';
  attribute?: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  secret?: boolean;
}
export interface OwnerExtractRequest {
  pageTargetId: string;
  selector: string;
  maxRows: number;
  fields: Record<string, OwnerExtractField>;
}
export interface OwnerExtractResult {
  documentId: string;
  rows: Record<string, string | number | boolean>[];
  secretFields: string[];
}
export function validateExtraction(value: unknown, allowValues: boolean): OwnerExtractRequest {
  if (!value || typeof value !== 'object') throw new Error('Owner extraction object required');
  const request = value as OwnerExtractRequest;
  if (
    typeof request.pageTargetId !== 'string' ||
    !request.pageTargetId ||
    typeof request.selector !== 'string' ||
    !request.selector ||
    request.selector.length > 4096 ||
    !Number.isSafeInteger(request.maxRows) ||
    request.maxRows < 1 ||
    request.maxRows > 1000 ||
    !request.fields ||
    typeof request.fields !== 'object'
  )
    throw new Error('Invalid bounded owner extraction');
  const fields = Object.entries(request.fields);
  if (fields.length < 1 || fields.length > 64)
    throw new Error('Owner extraction field bound exceeded');
  for (const [key, field] of fields) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !field ||
      typeof field.selector !== 'string' ||
      field.selector.length > 4096 ||
      !['text', 'value', 'attribute'].includes(field.source) ||
      !['string', 'number', 'boolean'].includes(field.type)
    )
      throw new Error('Invalid owner extraction field');
    if (field.source === 'value' && (!allowValues || field.secret !== true))
      throw new Error('Owner value extraction requires trusted permission and secret field');
    if (
      field.source === 'attribute' &&
      (typeof field.attribute !== 'string' ||
        !/^(?:data-[\w-]+|aria-[\w-]+|id|role|title|href|checked|disabled)$/.test(field.attribute))
    )
      throw new Error('Owner extraction attribute is not permitted');
  }
  return structuredClone(request);
}
export function extractionExpression(request: OwnerExtractRequest): string {
  return `(()=>{const spec=${JSON.stringify(request)};const excluded='input,textarea,select,[contenteditable],[data-sensitive],[data-secret],[data-private],script,style';const rows=Array.from(document.querySelectorAll(spec.selector));if(rows.length>spec.maxRows)throw Error('Owner extraction row bound exceeded');return rows.map(row=>Object.fromEntries(Object.entries(spec.fields).map(([key,f])=>{const matches=f.selector?row.querySelectorAll(f.selector):[row];if(matches.length>1)throw Error('Owner field is ambiguous');const e=matches[0];if(!e)return [key,null];if(f.source==='value')return [key,String(e.value??'')];if(e.closest(excluded))return [key,null];if(f.source==='attribute'){let value=e.getAttribute(f.attribute);if(f.attribute==='href'&&value){const u=new URL(value,location.href);u.username='';u.password='';u.search='';u.hash='';value=u.href}return [key,value]}const clone=e.cloneNode(true);for(const item of clone.querySelectorAll(excluded))item.remove();return [key,clone.textContent?.slice(0,10000)??'']})))})()`;
}
export function projectExtraction(
  request: OwnerExtractRequest,
  raw: unknown,
  redact: (text: string) => string,
  documentId: string
): OwnerExtractResult {
  if (!Array.isArray(raw) || raw.length > request.maxRows)
    throw new Error('Owner extraction result invalid');
  const rows = raw.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Owner extraction row invalid');
    const output: Record<string, string | number | boolean> = {};
    for (const [key, field] of Object.entries(request.fields)) {
      const value = (row as Record<string, unknown>)[key];
      if (value === null || value === undefined) {
        if (field.required) throw new Error('Required owner extraction field missing');
        continue;
      }
      if (typeof value !== 'string') throw new Error('Owner extraction cell invalid');
      const text = field.source === 'value' ? value : redact(value);
      if (field.type === 'string') output[key] = text;
      else if (field.type === 'number') {
        if (!text.trim() || !Number.isFinite(Number(text)))
          throw new Error('Owner extraction numeric cell invalid');
        output[key] = Number(text);
      } else {
        if (text !== 'true' && text !== 'false')
          throw new Error('Owner extraction boolean cell invalid');
        output[key] = text === 'true';
      }
    }
    return output;
  });
  return {
    documentId,
    rows,
    secretFields: Object.entries(request.fields)
      .filter(([, field]) => field.secret)
      .map(([key]) => key),
  };
}
