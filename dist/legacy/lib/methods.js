"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.METHOD_CAPABILITY = exports.METHOD_REQUIRES_BUSINESS = exports.METHOD_LABELS = void 0;
exports.requiresAnyBusiness = requiresAnyBusiness;
exports.METHOD_LABELS = {
    dine_and_donate: "Dine & Donate",
    shop_and_donate: "Shop & Donate",
    service_giveback: "Service Giveback",
    virtual_donations: "Virtual Donations",
    ambassador_fundraising: "Ambassador Fundraising",
    guest_bartending_event: "Guest Bartender",
};
exports.METHOD_REQUIRES_BUSINESS = {
    dine_and_donate: true,
    shop_and_donate: true,
    service_giveback: true,
    virtual_donations: false,
    ambassador_fundraising: false,
    guest_bartending_event: true,
};
exports.METHOD_CAPABILITY = {
    dine_and_donate: "supports_dine_and_donate",
    shop_and_donate: "supports_shop_and_donate",
    service_giveback: "supports_service_giveback",
    virtual_donations: "supports_ambassador_tracking",
    ambassador_fundraising: "supports_ambassador_tracking",
    guest_bartending_event: "supports_guest_bartending",
};
function requiresAnyBusiness(methods) {
    return methods.some((m) => exports.METHOD_REQUIRES_BUSINESS[m]);
}
//# sourceMappingURL=methods.js.map