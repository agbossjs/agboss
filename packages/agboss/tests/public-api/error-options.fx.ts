/** #906 AC1: a fixture typed by its class's constructor. */
type Ctor = new (options: never) => Error;

/** One fixture: the class's name and its options, typed by the class. */
export const fx = <C extends Ctor>(
  ErrorClass: C,
  options: ConstructorParameters<C>[0],
): readonly [string, object] => [ErrorClass.name, options];
