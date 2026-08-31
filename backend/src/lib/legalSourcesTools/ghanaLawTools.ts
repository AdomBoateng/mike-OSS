// Tool schemas, prompt fragment and wire events for Ghana primary legislation.
// The client lives in ../ghanaLaw.ts; this module is what the model sees.

export type GhanaLawToolEvent =
  | {
        type: "ghana_law_search";
        query: string;
        result_count: number;
        error?: string;
    }
  | {
        type: "ghana_law_read";
        title: string;
        url: string;
        /** "text" — extracted; "scan" — image-only; "empty" — nothing attached. */
        quality: "text" | "scan" | "empty";
        pages: number;
        chars: number;
        /** Offset of the slice returned, for a paginated read. */
        offset?: number;
        truncated?: boolean;
        error?: string;
    }
  | {
        type: "ghana_law_find_in";
        title: string;
        url: string;
        query: string;
        match_count: number;
        error?: string;
    }
  | {
        type: "ghana_law_find_amendments";
        act_name: string;
        amendments: { title: string; url: string; issued: string | null }[];
        error?: string;
    };

export const GHANA_LAW_TOOL_NAMES = {
    search: "ghana_law_search",
    read: "ghana_law_read",
    findIn: "ghana_law_find_in",
    findAmendments: "ghana_law_find_amendments",
} as const;

/** Max characters returned by one ghana_law_read call. */
export const GHANA_READ_CHUNK_CHARS = 12000;

export const GHANA_LAW_SYSTEM_PROMPT = `GHANA LEGISLATION:
You can look up Ghanaian primary legislation (Acts, and to a lesser extent
Constitutional/Executive/Legislative Instruments and older Decrees) from the
Parliament of Ghana Library Repository.

How to use it:
1. ${GHANA_LAW_TOOL_NAMES.search} to find an Act by name or subject. Search first; do not ask
   the user for an Act number before trying.
2. ${GHANA_LAW_TOOL_NAMES.findIn} to locate specific provisions inside an Act. Acts are long —
   hundreds of thousands of characters — so prefer this over reading the whole
   document. Use ${GHANA_LAW_TOOL_NAMES.read} only when you genuinely need continuous text,
   and page through it with the offset it returns.
3. ${GHANA_LAW_TOOL_NAMES.findAmendments} whenever you rely on an Act's text (see below).

You MUST observe these limits when answering:

- The text is the Act **as enacted**, not as amended. Amendments are stored as
  separate Acts and are NOT folded in. Never state or imply that quoted text is
  the current law without checking ${GHANA_LAW_TOOL_NAMES.findAmendments} and telling the user
  what you found. If amendments exist, name them and say the provision may have
  changed.
- Always cite the Act by short title, Act number and year, and give the
  repository URL returned by the tool.
- Roughly a third of the collection is scanned images with no machine-readable
  text. When a read returns quality "scan", say plainly that the Act is in the
  repository but only as a scanned image you cannot read, and do not substitute
  remembered text for it. The same applies to "empty".
- Coverage of subsidiary legislation is thin. If a search finds nothing, say the
  repository has no matching item — never conclude that no such law exists.
- If the attached filename disagrees with the item title, mention both; the
  repository's metadata is not always consistent.

This tool covers legislation only. There is no Ghanaian case-law source, so do
not claim to have checked Ghanaian judgments.`;

export const GHANA_LAW_TOOLS = [
    {
        type: "function",
        function: {
            name: GHANA_LAW_TOOL_NAMES.search,
            description:
                'Search Ghanaian primary legislation by short title or subject (e.g. "Companies Act" or "data protection"). Returns matching Acts and instruments with their title, year and an item id to pass to the other ghana_law tools. Scoped to legislation only — it will not return committee reports or Hansard. Use this first when a question concerns Ghanaian statute law.',
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Short title or subject keywords, e.g. 'Companies Act 2019' or 'mental health'.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum results to return (1-25, default 10).",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: GHANA_LAW_TOOL_NAMES.findIn,
            description:
                "Find passages inside one Act by keyword or phrase. This is the preferred way to read legislation: Acts run to hundreds of thousands of characters, so search for the provision you need rather than reading the whole document. Returns excerpts with page numbers.",
            parameters: {
                type: "object",
                properties: {
                    itemId: {
                        type: "string",
                        description: "Item id from ghana_law_search.",
                    },
                    query: {
                        type: "string",
                        description:
                            "Word or phrase to find, e.g. 'director' or 'good faith'.",
                    },
                    maxMatches: {
                        type: "integer",
                        description: "Maximum excerpts to return (1-25, default 8).",
                    },
                },
                required: ["itemId", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: GHANA_LAW_TOOL_NAMES.read,
            description:
                "Read continuous text from one Act, starting at a character offset. Returns at most ~12,000 characters per call along with the total length and the next offset, so you can page through. Prefer ghana_law_find_in unless you need to read a passage in sequence. If the Act is a scanned image this reports quality 'scan' and returns no text.",
            parameters: {
                type: "object",
                properties: {
                    itemId: {
                        type: "string",
                        description: "Item id from ghana_law_search.",
                    },
                    offset: {
                        type: "integer",
                        description:
                            "Character offset to start from (default 0). Use the nextOffset from a previous call to continue.",
                    },
                },
                required: ["itemId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: GHANA_LAW_TOOL_NAMES.findAmendments,
            description:
                "List amendment Acts for a principal Act. The repository stores legislation as enacted and does not consolidate amendments, so call this before relying on any Act's text, and tell the user what it found. An empty result means the repository holds no amendment item — not that the Act is unamended.",
            parameters: {
                type: "object",
                properties: {
                    actName: {
                        type: "string",
                        description:
                            "Short title of the principal Act, e.g. 'National Health Insurance Act'.",
                    },
                },
                required: ["actName"],
            },
        },
    },
] as const;
