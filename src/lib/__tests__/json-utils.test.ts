import { fixJsonBackslashes } from '../json-utils';

describe('fixJsonBackslashes', () => {
  test('already valid double-backslash unchanged', () => {
    const input = '{"content": "\\\\textbf{Result}"}';
    expect(fixJsonBackslashes(input)).toBe(input);
  });

  test('bare backslash before t is escaped', () => {
    const input = '{"content": "\\textbf{Result}"}';
    const expected = '{"content": "\\\\textbf{Result}"}';
    expect(fixJsonBackslashes(input)).toBe(expected);
  });

  test('bare backslash before percent is escaped', () => {
    const input = '{"content": "50\\% growth"}';
    const expected = '{"content": "50\\\\% growth"}';
    expect(fixJsonBackslashes(input)).toBe(expected);
  });

  test('\\n escape is doubled (pipeline .replace converts it to actual newline)', () => {
    const input = '{"content": "line1\\nline2"}';
    const expected = '{"content": "line1\\\\nline2"}';
    expect(fixJsonBackslashes(input)).toBe(expected);
  });

  test('literal newline inside string is escaped', () => {
    // Actual 0x0A newline inside JSON string causes "Bad control character" — must be escaped
    const input = '{"content": "line1\nline2"}';
    const expected = '{"content": "line1\\nline2"}';
    expect(fixJsonBackslashes(input)).toBe(expected);
  });
});
