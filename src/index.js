/** 模块统一入口。 */

export { CredentialingService, GovernanceError } from "./service.js";
export { EventStore, EventValidationError, ConcurrencyError } from "./event-store.js";
export { Registries, RegistryError } from "./registries.js";
export { Projection, scopeMatches } from "./projection.js";
export { evaluateEvidence } from "./policy.js";
export { AuditLog } from "./audit.js";
export { ROLE_ORDER, roleLevel, roleCovers } from "./roles.js";
export {
  deidentifyTeachingCase,
  pseudonymizeCase,
  projectCaseForPurpose,
  DeidentificationError,
} from "./deidentify.js";
export { validateEvent, EVENT_TYPES, AGGREGATE_TYPES, CASE_ROLES } from "./validator.js";
