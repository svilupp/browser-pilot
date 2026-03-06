/**
 * US keyboard layout map for CDP key events.
 * Maps characters/keys to their Input.dispatchKeyEvent properties.
 */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string; // Only for printable characters
  location?: number;
}

export const US_KEYBOARD: Record<string, KeyDefinition> = {
  // Letters (lowercase)
  a: { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
  b: { key: 'b', code: 'KeyB', keyCode: 66, text: 'b' },
  c: { key: 'c', code: 'KeyC', keyCode: 67, text: 'c' },
  d: { key: 'd', code: 'KeyD', keyCode: 68, text: 'd' },
  e: { key: 'e', code: 'KeyE', keyCode: 69, text: 'e' },
  f: { key: 'f', code: 'KeyF', keyCode: 70, text: 'f' },
  g: { key: 'g', code: 'KeyG', keyCode: 71, text: 'g' },
  h: { key: 'h', code: 'KeyH', keyCode: 72, text: 'h' },
  i: { key: 'i', code: 'KeyI', keyCode: 73, text: 'i' },
  j: { key: 'j', code: 'KeyJ', keyCode: 74, text: 'j' },
  k: { key: 'k', code: 'KeyK', keyCode: 75, text: 'k' },
  l: { key: 'l', code: 'KeyL', keyCode: 76, text: 'l' },
  m: { key: 'm', code: 'KeyM', keyCode: 77, text: 'm' },
  n: { key: 'n', code: 'KeyN', keyCode: 78, text: 'n' },
  o: { key: 'o', code: 'KeyO', keyCode: 79, text: 'o' },
  p: { key: 'p', code: 'KeyP', keyCode: 80, text: 'p' },
  q: { key: 'q', code: 'KeyQ', keyCode: 81, text: 'q' },
  r: { key: 'r', code: 'KeyR', keyCode: 82, text: 'r' },
  s: { key: 's', code: 'KeyS', keyCode: 83, text: 's' },
  t: { key: 't', code: 'KeyT', keyCode: 84, text: 't' },
  u: { key: 'u', code: 'KeyU', keyCode: 85, text: 'u' },
  v: { key: 'v', code: 'KeyV', keyCode: 86, text: 'v' },
  w: { key: 'w', code: 'KeyW', keyCode: 87, text: 'w' },
  x: { key: 'x', code: 'KeyX', keyCode: 88, text: 'x' },
  y: { key: 'y', code: 'KeyY', keyCode: 89, text: 'y' },
  z: { key: 'z', code: 'KeyZ', keyCode: 90, text: 'z' },

  // Letters (uppercase)
  A: { key: 'A', code: 'KeyA', keyCode: 65, text: 'A' },
  B: { key: 'B', code: 'KeyB', keyCode: 66, text: 'B' },
  C: { key: 'C', code: 'KeyC', keyCode: 67, text: 'C' },
  D: { key: 'D', code: 'KeyD', keyCode: 68, text: 'D' },
  E: { key: 'E', code: 'KeyE', keyCode: 69, text: 'E' },
  F: { key: 'F', code: 'KeyF', keyCode: 70, text: 'F' },
  G: { key: 'G', code: 'KeyG', keyCode: 71, text: 'G' },
  H: { key: 'H', code: 'KeyH', keyCode: 72, text: 'H' },
  I: { key: 'I', code: 'KeyI', keyCode: 73, text: 'I' },
  J: { key: 'J', code: 'KeyJ', keyCode: 74, text: 'J' },
  K: { key: 'K', code: 'KeyK', keyCode: 75, text: 'K' },
  L: { key: 'L', code: 'KeyL', keyCode: 76, text: 'L' },
  M: { key: 'M', code: 'KeyM', keyCode: 77, text: 'M' },
  N: { key: 'N', code: 'KeyN', keyCode: 78, text: 'N' },
  O: { key: 'O', code: 'KeyO', keyCode: 79, text: 'O' },
  P: { key: 'P', code: 'KeyP', keyCode: 80, text: 'P' },
  Q: { key: 'Q', code: 'KeyQ', keyCode: 81, text: 'Q' },
  R: { key: 'R', code: 'KeyR', keyCode: 82, text: 'R' },
  S: { key: 'S', code: 'KeyS', keyCode: 83, text: 'S' },
  T: { key: 'T', code: 'KeyT', keyCode: 84, text: 'T' },
  U: { key: 'U', code: 'KeyU', keyCode: 85, text: 'U' },
  V: { key: 'V', code: 'KeyV', keyCode: 86, text: 'V' },
  W: { key: 'W', code: 'KeyW', keyCode: 87, text: 'W' },
  X: { key: 'X', code: 'KeyX', keyCode: 88, text: 'X' },
  Y: { key: 'Y', code: 'KeyY', keyCode: 89, text: 'Y' },
  Z: { key: 'Z', code: 'KeyZ', keyCode: 90, text: 'Z' },

  // Numbers
  '0': { key: '0', code: 'Digit0', keyCode: 48, text: '0' },
  '1': { key: '1', code: 'Digit1', keyCode: 49, text: '1' },
  '2': { key: '2', code: 'Digit2', keyCode: 50, text: '2' },
  '3': { key: '3', code: 'Digit3', keyCode: 51, text: '3' },
  '4': { key: '4', code: 'Digit4', keyCode: 52, text: '4' },
  '5': { key: '5', code: 'Digit5', keyCode: 53, text: '5' },
  '6': { key: '6', code: 'Digit6', keyCode: 54, text: '6' },
  '7': { key: '7', code: 'Digit7', keyCode: 55, text: '7' },
  '8': { key: '8', code: 'Digit8', keyCode: 56, text: '8' },
  '9': { key: '9', code: 'Digit9', keyCode: 57, text: '9' },

  // Punctuation
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  '.': { key: '.', code: 'Period', keyCode: 190, text: '.' },
  ',': { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  '/': { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  ';': { key: ';', code: 'Semicolon', keyCode: 186, text: ';' },
  "'": { key: "'", code: 'Quote', keyCode: 222, text: "'" },
  '[': { key: '[', code: 'BracketLeft', keyCode: 219, text: '[' },
  ']': { key: ']', code: 'BracketRight', keyCode: 221, text: ']' },
  '\\': { key: '\\', code: 'Backslash', keyCode: 220, text: '\\' },
  '-': { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  '=': { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  '`': { key: '`', code: 'Backquote', keyCode: 192, text: '`' },

  // Shifted punctuation
  '!': { key: '!', code: 'Digit1', keyCode: 49, text: '!' },
  '@': { key: '@', code: 'Digit2', keyCode: 50, text: '@' },
  '#': { key: '#', code: 'Digit3', keyCode: 51, text: '#' },
  $: { key: '$', code: 'Digit4', keyCode: 52, text: '$' },
  '%': { key: '%', code: 'Digit5', keyCode: 53, text: '%' },
  '^': { key: '^', code: 'Digit6', keyCode: 54, text: '^' },
  '&': { key: '&', code: 'Digit7', keyCode: 55, text: '&' },
  '*': { key: '*', code: 'Digit8', keyCode: 56, text: '*' },
  '(': { key: '(', code: 'Digit9', keyCode: 57, text: '(' },
  ')': { key: ')', code: 'Digit0', keyCode: 48, text: ')' },
  _: { key: '_', code: 'Minus', keyCode: 189, text: '_' },
  '+': { key: '+', code: 'Equal', keyCode: 187, text: '+' },
  '{': { key: '{', code: 'BracketLeft', keyCode: 219, text: '{' },
  '}': { key: '}', code: 'BracketRight', keyCode: 221, text: '}' },
  '|': { key: '|', code: 'Backslash', keyCode: 220, text: '|' },
  ':': { key: ':', code: 'Semicolon', keyCode: 186, text: ':' },
  '"': { key: '"', code: 'Quote', keyCode: 222, text: '"' },
  '<': { key: '<', code: 'Comma', keyCode: 188, text: '<' },
  '>': { key: '>', code: 'Period', keyCode: 190, text: '>' },
  '?': { key: '?', code: 'Slash', keyCode: 191, text: '?' },
  '~': { key: '~', code: 'Backquote', keyCode: 192, text: '~' },

  // Special keys (non-text: use rawKeyDown, no text field)
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** Check if a character is in the US keyboard layout */
export function isLayoutCharacter(char: string): boolean {
  return char in US_KEYBOARD;
}
