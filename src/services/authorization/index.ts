export {
  AuthorizationService,
  GOD_ACCESS_IDS,
  hasGodAccess,
  type AuthorizationContext,
  type AuthorizationDecision,
  type AuthorizationOutcome,
  type AuthorizationServiceOptions,
  type PermissionRequest,
} from "./authorization.service.js";
export {
  BUILT_IN_PERMISSION_CLASSES,
  builtInPermissionClass,
  classLabel,
  permissionsGrantedByClasses,
  type BuiltInPermissionClassKey,
  type PermissionClassDefinition,
} from "./permission-classes.js";
export {
  PermissionClassStore,
  type MemberClassFacts,
  type PermissionClassStoreOptions,
} from "./permission-class.store.js";
export {
  PrismaPermissionClassRepository,
  type PermissionClassRepository,
  type PermissionClassRow,
  type RoleClassBinding,
} from "./permission-class.repository.js";
export {
  LEGACY_BOT_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  permissionsByModule,
  toBotPermission,
  toPermission,
  unknownPermissions,
  type Permission,
} from "./permissions.js";
