export declare const SETTLEMENT_PDF_DIR: string;
export declare function ensureSettlementPdfDir(campaignId: number): string;
export declare function buildSimplePdf(title: string, lines: string[]): Buffer;
export declare function settlementLetterheadLines(docTitle: string): string[];
export declare function writeSettlementPdf(campaignId: number, filename: string, title: string, lines: string[]): string;
export declare function moneyLine(label: string, amount: number): string;
