// HTTP authentication (#1316): who calls a listener, the one decorator and result every listener takes.
export {
  HttpAuthenticator,
  type HttpAuthenticatorHandler,
  type HttpAuthenticatorMeta,
  type HttpAuthenticatorOptions,
} from "../http/http-authenticator.js";
export {
  HttpAuthKind,
  HttpAuthResult,
  type AuthenticatedHttpAuthResult,
  type HttpAuthRequest,
  type HttpCaller,
  type RejectedHttpAuthResult,
} from "../http/http-auth.js";
export {
  HttpSecurity,
  HttpSecuritySchemeKind,
  type HttpSecurityScheme,
} from "../http/http-security.js";
