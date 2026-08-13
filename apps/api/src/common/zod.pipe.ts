import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';

/**
 * Validates a request body/query against a Zod schema from @hishab/shared, so
 * client and server enforce exactly the same contract.
 *
 * Two type parameters, not one. `ZodSchema<T>` is `ZodType<T, ZodTypeDef, T>` —
 * input and output the same — which is true only of a schema that does no
 * transforming. The ones that matter here do: login accepts `email` *or*
 * `identifier` and hands back one field, signup takes whatever spelling of a
 * mobile number somebody typed and hands back the canonical `01XXXXXXXXX`.
 * Narrowing both ends to the output type made those unassignable.
 */
@Injectable()
export class ZodValidationPipe<Out, In = Out> implements PipeTransform<unknown, Out> {
  constructor(private readonly schema: ZodType<Out, ZodTypeDef, In>) {}

  transform(value: unknown): Out {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      throw err;
    }
  }
}

export const zodPipe = <Out, In>(
  schema: ZodType<Out, ZodTypeDef, In>,
): ZodValidationPipe<Out, In> => new ZodValidationPipe(schema);
