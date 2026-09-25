/**
 * The supported way to run DQL inside another program (RFC 0010): start the
 * server with host hooks. Import from `@duckcodeailabs/dql-cli/host`.
 */
export { startLocalServer, type LocalServerOptions } from '../local-runtime.js';
export {
  currentPrincipal,
  currentRequestContext,
  type DqlDecision,
  type DqlHostHooks,
  type DqlPrincipal,
  type DqlRequestContext,
} from './request-context.js';
export { routeAction, type DqlAction, type DqlResource, type DqlRouteAction } from './route-actions.js';
