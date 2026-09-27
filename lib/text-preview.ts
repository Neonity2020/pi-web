import fs from "fs";
import { TEXT_EDIT_MAX_BYTES, TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export interface TextPreviewChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

export interface TextFullContent {
  content: string;
  size: number;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function readTextPreviewChunk(
  filePath: string,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }

  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);
  if (offset + end < fileSize) {
    let sequenceStart = end;
    while (sequenceStart > end - 3 && (buffer[sequenceStart] & 0xc0) === 0x80) {
      sequenceStart--;
    }
    if (utf8SequenceLength(buffer[sequenceStart]) > end - sequenceStart) {
      end = sequenceStart;
    }
  }
  const nextOffset = offset + end;

  return {
    content: buffer.toString("utf8", 0, end),
    nextOffset,
    truncated: nextOffset < fileSize,
  };
}

/**
 * Read a whole text file. Preview reads are chunked because a file can be far
 * larger than memory should hold; the editor instead loads the entire document
 * once and later writes it back, so the read is bounded by TEXT_EDIT_MAX_BYTES
 * and `exceededLimit` tells the caller to keep the editor closed.
 */
export function readFullTextFile(
  filePath: string,
  maxBytes: number = TEXT_EDIT_MAX_BYTES,
): TextFullContent & { exceededLimit: boolean } {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    return { content: "", size: stat.size, exceededLimit: true };
  }

  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, stat.size, 0);
    return {
      content: buffer.toString("utf8", 0, bytesRead),
      size: stat.size,
      exceededLimit: false,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}
