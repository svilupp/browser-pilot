import type { FormField, InteractiveElement } from '../../browser/types.ts';

function fieldIdentifier(field: FormField): string {
  if (field.id) return `#${field.id}`;
  if (field.name) return `name=${field.name}`;
  return `<${field.tag}>`;
}

function fieldState(field: FormField): string {
  if (field.type === 'checkbox' || field.type === 'radio') {
    return field.checked ? 'checked' : 'unchecked';
  }

  if (Array.isArray(field.value)) {
    return field.value.length > 0 ? field.value.join(', ') : '""';
  }

  if (typeof field.value === 'string') {
    return JSON.stringify(field.value);
  }

  return '""';
}

function fieldMeta(field: FormField): string {
  const bits = [field.label];
  if (field.required) bits.push('required');
  if (field.disabled) bits.push('disabled');
  return bits.filter(Boolean).join(' | ');
}

export function formatFormFieldsPretty(fields: FormField[]): string[] {
  const lines: string[] = [];
  const seenRadioGroups = new Set<string>();

  for (const field of fields) {
    if (field.type === 'radio' && field.name) {
      if (seenRadioGroups.has(field.name)) continue;
      seenRadioGroups.add(field.name);

      const group = fields.filter(
        (candidate) => candidate.type === 'radio' && candidate.name === field.name
      );
      const options = group
        .map((candidate) => {
          const label = candidate.label || candidate.value || candidate.id || '(unnamed)';
          return candidate.checked ? `${label} [checked]` : label;
        })
        .join(' | ');
      const meta = fieldMeta(group.find((candidate) => candidate.label) ?? field);
      lines.push(`  ${fieldIdentifier(field)}  radio  ${options}${meta ? `  ${meta}` : ''}`);
      continue;
    }

    let state = fieldState(field);
    if (field.options?.length) {
      const options = field.options
        .map((option) => (option.selected ? `${option.text} [selected]` : option.text))
        .join(' | ');
      state += options ? `  ${options}` : '';
    }

    const meta = fieldMeta(field);
    lines.push(`  ${fieldIdentifier(field)}  ${field.type}  ${state}${meta ? `  ${meta}` : ''}`);
  }

  return lines;
}

export function formatInteractiveElementsPretty(
  elements: InteractiveElement[],
  limit = elements.length
): string[] {
  return elements.slice(0, limit).map((element) => {
    let line = `  ref:${element.ref} ${element.role}`;
    if (element.name) {
      line += ` "${element.name}"`;
    }
    if (element.disabled) {
      line += ' (disabled)';
    }
    if (element.checked !== undefined) {
      line += element.checked ? ' (checked)' : ' (unchecked)';
    }
    return line;
  });
}
