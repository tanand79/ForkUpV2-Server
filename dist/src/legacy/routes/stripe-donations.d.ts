import { type Request, type Response } from "express";
export declare const stripeConfigRouter: import("express-serve-static-core").Router;
export declare const stripeCheckoutRouter: import("express-serve-static-core").Router;
export declare function stripeWebhookHandler(req: Request, res: Response): Promise<void>;
