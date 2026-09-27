export interface Section {
  /** Heading path, e.g. "Guide > Usage > Flags"; empty for text before the first heading. */
  heading: string;
  startLine: number;
  endLine: number;
  content: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function splitLong(section: Section, maxChars: number): Section[] {
  if (section.content.length <= maxChars) return [section];
  const lines = section.content.split('\n');
  const parts: Section[] = [];
  let start = 0;
  while (start < lines.length) {
    let size = 0;
    let end = start;
    while (end < lines.length && (end === start || size + lines[end]!.length + 1 <= maxChars)) {
      size += lines[end]!.length + 1;
      end++;
    }
    parts.push({
      heading: section.heading,
      startLine: section.startLine + start,
      endLine: section.startLine + end - 1,
      content: lines.slice(start, end).join('\n'),
    });
    start = end;
  }
  return parts;
}

/** Splits Markdown at headings (not inside fenced code); long sections are cut at line breaks. */
export function splitSections(markdown: string, maxChars = 1500): Section[] {
  const lines = markdown.split('\n');
  const stack: { level: number; text: string }[] = [];
  const sections: Section[] = [];
  let current: { heading: string; start: number } = { heading: '', start: 0 };
  let inFence = false;
  const close = (endExclusive: number): void => {
    const content = lines.slice(current.start, endExclusive).join('\n');
    if (content.trim() === '') return;
    sections.push(
      ...splitLong(
        { heading: current.heading, startLine: current.start + 1, endLine: endExclusive, content },
        maxChars,
      ),
    );
  };
  lines.forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (!heading) return;
    close(i);
    const level = heading[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: heading[2]! });
    current = { heading: stack.map((h) => h.text).join(' > '), start: i };
  });
  close(lines.length);
  return sections;
}
