import { Integration, Transaction } from '@sentry/types';
import { logger } from '@sentry/utils';
// tslint:disable-next-line:no-implicit-dependencies
import { Application, ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Internal helper for `__sentry_transaction`
 * @hidden
 */
interface SentryTracingResponse {
  __sentry_transaction?: Transaction;
}

/**
 * Express integration
 *
 * Provides an request and error handler for Express framework
 * as well as tracing capabilities
 */
export class Express implements Integration {
  /**
   * @inheritDoc
   */
  public name: string = Express.id;

  /**
   * @inheritDoc
   */
  public static id: string = 'Express';

  /**
   * Express App instance
   */
  private readonly _app?: Application;

  /**
   * @inheritDoc
   */
  public constructor(options: { app?: Application } = {}) {
    this._app = options.app;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    if (!this._app) {
      logger.error('ExpressIntegration is missing an Express instance');
      return;
    }
    instrumentMiddlewares(this._app);
  }
}

/**
 * Wraps original middleware function in a tracing call, which stores the info about the call as a span,
 * and finishes it once the middleware is done invoking.
 *
 * Express middlewares have 3 various forms, thus we have to take care of all of them:
 * // sync
 * app.use(function (req, res) { ... })
 * // async
 * app.use(function (req, res, next) { ... })
 * // error handler
 * app.use(function (err, req, res, next) { ... })
 */
function wrap(fn: Function): RequestHandler | ErrorRequestHandler {
  const arrity = fn.length;

  switch (arrity) {
    case 2: {
      return function(this: NodeJS.Global, _req: Request, res: Response & SentryTracingResponse): any {
        const transaction = res.__sentry_transaction;
        if (transaction) {
          const span = transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
          res.once('finish', () => {
            span.finish();
          });
        }
        return fn.apply(this, arguments);
      };
    }
    case 3: {
      return function(
        this: NodeJS.Global,
        req: Request,
        res: Response & SentryTracingResponse,
        next: NextFunction,
      ): any {
        const transaction = res.__sentry_transaction;
        const span =
          transaction &&
          transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
        fn.call(this, req, res, function(this: NodeJS.Global): any {
          if (span) {
            span.finish();
          }
          return next.apply(this, arguments);
        });
      };
    }
    case 4: {
      return function(
        this: NodeJS.Global,
        err: any,
        req: Request,
        res: Response & SentryTracingResponse,
        next: NextFunction,
      ): any {
        const transaction = res.__sentry_transaction;
        const span =
          transaction &&
          transaction.startChild({
            description: fn.name,
            op: 'middleware',
          });
        fn.call(this, err, req, res, function(this: NodeJS.Global): any {
          if (span) {
            span.finish();
          }
          return next.apply(this, arguments);
        });
      };
    }
    default: {
      throw new Error(`Express middleware takes 2-4 arguments. Got: ${arrity}`);
    }
  }
}

/**
 * Takes all the function arguments passed to the original `app.use` call
 * and wraps every function, as well as array of functions with a call to our `wrap` method.
 * We have to take care of the arrays as well as iterate over all of the arguments,
 * as `app.use` can accept middlewares in few various forms.
 *
 * app.use([<path>], <fn>)
 * app.use([<path>], <fn>, ...<fn>)
 * app.use([<path>], ...<fn>[])
 */
function wrapUseArgs(args: IArguments): unknown[] {
  return Array.from(args).map((arg: unknown) => {
    if (typeof arg === 'function') {
      return wrap(arg);
    }

    if (Array.isArray(arg)) {
      return arg.map((a: unknown) => {
        if (typeof a === 'function') {
          return wrap(a);
        }
        return a;
      });
    }

    return arg;
  });
}

/**
 * Patches original app.use to utilize our tracing functionality
 */
function instrumentMiddlewares(app: Application): Application {
  const originalAppUse = app.use;
  app.use = function(): any {
    return originalAppUse.apply(this, wrapUseArgs(arguments));
  };
  return app;
}
