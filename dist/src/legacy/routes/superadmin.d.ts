import nodemailer from "nodemailer";
export declare const superadminRouter: import("express-serve-static-core").Router;
export declare function buildSmtpTransportFromSettings(): Promise<nodemailer.Transporter<import("nodemailer/lib/smtp-transport").SentMessageInfo, import("nodemailer/lib/smtp-transport").Options> | null>;
