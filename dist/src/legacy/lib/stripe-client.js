"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStripe = getStripe;
exports.isStripeConfigured = isStripeConfigured;
const stripe_1 = __importDefault(require("stripe"));
const config_1 = require("../config");
let cached;
function getStripe() {
    if (cached !== undefined)
        return cached;
    const key = config_1.config.stripe.secretKey;
    if (!key) {
        cached = null;
        return cached;
    }
    cached = new stripe_1.default(key, {
        apiVersion: "2025-02-24.acacia",
    });
    return cached;
}
function isStripeConfigured() {
    return Boolean(config_1.config.stripe.secretKey && config_1.config.stripe.publishableKey);
}
//# sourceMappingURL=stripe-client.js.map