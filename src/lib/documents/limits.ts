/**
 * Extraction limits. Upload limits (10 MiB, PDF/DOCX) mirror UPLOAD_RULES and the Storage bucket;
 * output limits mirror public.document_extracts (≤100,000 characters, page_count 0–50).
 */
export const EXTRACTION_LIMITS = {
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputChars: 100_000,
  /** Raw text collected before normalisation; extraction stops early once this is reached. */
  maxRawChars: 120_000,
  maxPdfPages: 50,
  /** Fewer letters/digits than this counts as "no meaningful text" (e.g. a scan). */
  minMeaningfulChars: 20,
  defaultDeadlineMs: 20_000,
  zip: {
    maxEntries: 1000,
    maxTotalUncompressedBytes: 50 * 1024 * 1024,
    maxDocumentXmlBytes: 20 * 1024 * 1024,
    maxContentTypesBytes: 1024 * 1024,
    maxCompressionRatio: 100,
    /** Entries that inflate to no more than this are exempt from the ratio rule (tiny XML parts). */
    ratioExemptBytes: 1024 * 1024,
    /** Compressed bytes fed to the inflater per step; bounds output per step to ~1 MiB. */
    inflateChunkBytes: 1024,
  },
} as const;

export const SUPPORTED_MIME_TYPES = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
} as const;
