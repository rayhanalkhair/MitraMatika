"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  startTransition,
  useActionState,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  useForm,
  type DefaultValues,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";
import { focusFirstInvalid, useFocusFirstInvalid } from "./focus-first-invalid";
import {
  toFormErrors,
  useServerFieldErrors,
  type ServerFieldErrors,
} from "./server-errors";

export interface ActionFormOptions<TIn extends FieldValues, TOut, S, P> {
  /** The form's schema: raw form values in, the action's input out. The action parses it too. */
  schema: z.ZodType<TOut, TIn>;
  /**
   * The starting values, or a function of the first state: a post without JavaScript renders the
   * action's state on the server, so a form that works without it starts from what was typed.
   */
  defaultValues: DefaultValues<TIn> | ((state: Awaited<S>) => DefaultValues<TIn>);
  action: (state: Awaited<S>, payload: P) => S | Promise<S>;
  initialState: Awaited<S>;
  /** What the action receives once the values are valid (the form's FormData, or an object). */
  toPayload: (values: TOut, form: HTMLFormElement) => P;
  /** The field errors in a state. Return the object stored in the state, not a fresh copy. */
  fieldErrorsOf: (state: Awaited<S>) => ServerFieldErrors | undefined;
  /** Told on a valid submit, before the action runs (e.g. to keep a "saved" notice). */
  onSubmitted?: () => void;
  /**
   * Fields whose validity depends on another field (a confirmation on its password): once the
   * form was submitted, a change of the key re-validates the listed fields too. Before the first
   * submit nothing is validated, so no cross-field error shows early. Typed: a typo is an error.
   */
  dependentFields?: Partial<Record<FieldPath<TIn>, readonly FieldPath<TIn>[]>>;
  /**
   * Like `dependentFields`, but the listed paths may be those of a cross-field issue that belongs
   * to no single field (the generation form's `material`), so they are not type-checked.
   */
  dependentErrorPaths?: Partial<Record<FieldPath<TIn>, readonly string[]>>;
}

export interface ActionForm<TIn extends FieldValues, TOut, S, P> {
  form: UseFormReturn<TIn, unknown, TOut>;
  formRef: RefObject<HTMLFormElement | null>;
  state: Awaited<S>;
  formAction: (payload: P) => void;
  pending: boolean;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
}

function isStateFunction<S, V>(value: V | ((state: S) => V)): value is (state: S) => V {
  return typeof value === "function";
}

/**
 * React Hook Form on top of `useActionState`: the browser validates with the form's Zod schema
 * (the same one the Server Action parses with), the action stays the transport (pending flag,
 * server state). Server field errors are mapped onto the fields; focus moves to the first invalid
 * field after a submit attempt or a server answer with field errors, never while the teacher types.
 *
 * The form is always submitted by hand inside a transition, never by `<form action>` alone, so
 * React does not reset the fields after a server error. A form that must work without JavaScript
 * may still set `action={formAction}`: `onSubmit` prevents the native submit whenever JS runs.
 */
export function useActionForm<TIn extends FieldValues, TOut, S, P>({
  schema,
  defaultValues,
  action,
  initialState,
  toPayload,
  fieldErrorsOf,
  onSubmitted,
  dependentFields,
  dependentErrorPaths,
}: ActionFormOptions<TIn, TOut, S, P>): ActionForm<TIn, TOut, S, P> {
  const [state, formAction, pending] = useActionState<S, P>(action, initialState);
  // A post without JavaScript renders the action's state on the server: its errors must be in
  // the first render, where effects never run.
  const [initialErrors] = useState(() => toFormErrors<TIn>(fieldErrorsOf(state)));
  const [initialValues] = useState<DefaultValues<TIn>>(() =>
    isStateFunction(defaultValues) ? defaultValues(state) : defaultValues,
  );
  const form = useForm<TIn, unknown, TOut>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    errors: initialErrors,
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldFocusError: false,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const { submitCount, errors } = form.formState;

  // A submit attempt: the errors and the new count arrive in the same render.
  useFocusFirstInvalid(formRef, submitCount);

  // A server answer: its errors are set in an effect and shown one render later, so focus waits
  // for that render (the next change of the errors object) instead of the state change.
  const focusServerErrors = useRef(false);
  useServerFieldErrors(form, fieldErrorsOf(state), () => {
    focusServerErrors.current = true;
  });
  useEffect(() => {
    if (!focusServerErrors.current) return;
    focusServerErrors.current = false;
    focusFirstInvalid(formRef.current);
  }, [errors]);

  // Every change of a field: after a submit, re-validate the fields that depend on it; before
  // one, drop a server error the field carries (a post made before JavaScript loaded), since
  // nothing else re-validates until the next submit.
  const { subscribe, trigger, clearErrors, getFieldState } = form;
  const onFieldChange = useEffectEvent((name: FieldPath<TIn>, isSubmitted: boolean) => {
    if (isSubmitted) {
      const dependents = [
        ...(dependentFields?.[name] ?? []),
        ...(dependentErrorPaths?.[name] ?? []),
      ];
      // trigger takes any path: the resolver's errors are copied or cleared for each name given.
      if (dependents.length > 0) void trigger(dependents as FieldPath<TIn>[]);
    } else if (getFieldState(name).error?.type === "server") {
      clearErrors(name);
    }
  });
  useEffect(
    () =>
      subscribe({
        formState: { values: true },
        callback: ({ name, isSubmitted }) => {
          if (name) onFieldChange(name as FieldPath<TIn>, isSubmitted === true);
        },
      }),
    [subscribe],
  );

  // One submit at a time: validation is asynchronous, and the button is disabled only once
  // `pending` renders, so a double Enter could queue the action twice. Released when the
  // validation fails or the action's answer arrives.
  const inFlight = useRef(false);
  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending, state]);

  function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    void form.handleSubmit(
      (values) => {
        const element = formRef.current;
        if (!element) {
          inFlight.current = false;
          return;
        }
        onSubmitted?.();
        startTransition(() => {
          formAction(toPayload(values, element));
        });
      },
      () => {
        inFlight.current = false;
      },
    )(event);
  }

  return { form, formRef, state, formAction, pending, onSubmit };
}
