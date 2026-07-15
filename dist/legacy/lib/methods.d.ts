import type { MethodType } from "../types/campaign";
export declare const METHOD_LABELS: Record<MethodType, string>;
export declare const METHOD_REQUIRES_BUSINESS: Record<MethodType, boolean>;
export declare const METHOD_CAPABILITY: Record<MethodType, string>;
export declare function requiresAnyBusiness(methods: MethodType[]): boolean;
