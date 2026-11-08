// The base of a bridge's container class in the dispatcher Worker, which
// pronto's edge-dispatcher.ts writes beside the dispatcher. Apart from
// dispatch.ts because the package imports cloudflare:workers, which resolves
// only in workerd, and dispatch.ts is tested outside it.
import { Container } from '@cloudflare/containers'

/** A stub's `fetch` starts the container, waits for its port and proxies the
 * request to it, as the package's `containerFetch` does, except that what the
 * infrastructure fails at is thrown rather than answered: the package turns
 * no instance (a first deploy provisioning, minutes), a start rate limit, a
 * port never ready and a connection lost mid-flight into 503, 429 and 500
 * responses, which a handler would judge as the sink's refusal and settle the
 * effect `failed` on its first run. Thrown, they are the run's error, which
 * the object counts, backs off and runs again, settling `unknown` only on the
 * effect's last attempt, as a transport error to an origin is. Only a
 * response the container produced reaches the handler.
 *
 * The package's count of in-flight requests, which keeps an instance from
 * sleeping mid-request, is private; a call is bounded by the sink's 45s and
 * the instance sleeps after ten idle minutes, so renewing the timeout at the
 * call suffices. */
export class Bridge extends Container {
  declare defaultPort: number

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container
    if (container === undefined) throw new Error(`${this.constructor.name} has no container: the dispatcher's config declares none for it`)
    const { status } = await this.getState()
    if (!container.running || status !== 'healthy') await this.startAndWaitForPorts(this.defaultPort, { abort: request.signal })
    this.renewActivityTimeout()
    return await container.getTcpPort(this.defaultPort).fetch(request.url.replace(/^https:/, 'http:'), request)
  }
}
