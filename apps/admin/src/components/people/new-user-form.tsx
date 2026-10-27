'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { generatePassword } from '@/lib/password';
import { ROLES } from '@/lib/people';
import { PageHeader } from '../shell/page-header';
import { Button, ButtonLink } from '../ui/button';
import { Checkbox, PasswordField, TextField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './people.module.css';

/**
 * Add user (wp-admin/user-new.php): username, email, name, role, a generated
 * password, and whether to email the new user a link to set their own.
 */
export function NewUserForm({ defaultRole }: { defaultRole: string }) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({
    username: '',
    email: '',
    first_name: '',
    last_name: '',
    url: '',
    role: ROLES.some((r) => r.id === defaultRole) ? defaultRole : 'subscriber',
  });
  const [password, setPassword] = useState(() => generatePassword());
  const [notify, setNotify] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof values, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors(({ [key]: _, ...rest }) => rest);
  };

  const focusFirstError = () =>
    requestAnimationFrame(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (!values.username.trim()) local.username = 'Choose a username.';
    if (!values.email.trim()) local.email = 'Enter an email address.';
    if (!password) local.password = 'Choose a password, or generate one.';
    if (Object.keys(local).length) {
      setErrors(local);
      focusFirstError();
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const { role, ...rest } = values;
      await api('/wp/v2/users', {
        method: 'POST',
        body: {
          ...rest,
          username: rest.username.trim(),
          email: rest.email.trim(),
          password,
          roles: [role],
          send_user_notification: notify,
        },
      });
      toast(
        notify
          ? `${values.username.trim()} added. We’ve emailed them a link to set their password.`
          : `${values.username.trim()} added.`,
      );
      router.push('/admin/users');
    } catch (error) {
      if (error instanceof ApiError && error.data.params) {
        const params = { ...error.data.params };
        if (params.roles) params.role = params.roles;
        setErrors(params);
        focusFirstError();
      } else {
        setProblem(error instanceof ApiError ? error.message : 'Could not add the user.');
      }
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Add user"
        description="Create an account and choose what this person can do."
        actions={
          <ButtonLink
            href="/admin/users"
            variant="ghost"
            icon={<ArrowLeft size={16} aria-hidden="true" />}
          >
            All users
          </ButtonLink>
        }
      />
      <form ref={formRef} className={styles.layout} onSubmit={submit} noValidate>
        {problem && <Notice tone="danger" title={problem} />}

        <Card title="Account">
          <div className={styles.fields}>
            <TextField
              label="Username"
              hint="Used to log in. It can’t be changed later."
              value={values.username}
              onChange={(e) => set('username', e.target.value)}
              error={errors.username}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={60}
              autoFocus
            />
            <TextField
              label="Email"
              type="email"
              value={values.email}
              onChange={(e) => set('email', e.target.value)}
              error={errors.email}
              autoComplete="off"
            />
            <div className={styles.two}>
              <TextField
                label="First name"
                optional
                value={values.first_name}
                onChange={(e) => set('first_name', e.target.value)}
                autoComplete="off"
              />
              <TextField
                label="Last name"
                optional
                value={values.last_name}
                onChange={(e) => set('last_name', e.target.value)}
                autoComplete="off"
              />
            </div>
            <TextField
              label="Website"
              type="url"
              optional
              placeholder="https://"
              value={values.url}
              onChange={(e) => set('url', e.target.value)}
              error={errors.url}
              autoComplete="off"
            />
          </div>
        </Card>

        <Card title="Role" description="You can change it at any time.">
          <fieldset className={styles.roleGrid}>
            <legend className="visually-hidden">Role</legend>
            {ROLES.map((role) => (
              <label key={role.id} className={styles.roleOption}>
                <input
                  type="radio"
                  name="role"
                  value={role.id}
                  checked={values.role === role.id}
                  onChange={() => set('role', role.id)}
                />
                <span className={styles.roleText}>
                  <span>{role.label}</span>
                  <span className={styles.roleSummary}>{role.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {errors.role && (
            <p role="alert" className={styles.muted}>
              {errors.role}
            </p>
          )}
        </Card>

        <Card title="Password">
          <div className={styles.fields}>
            <PasswordField
              label="Password"
              isNew
              value={password}
              onChange={(v) => {
                setPassword(v);
                setErrors(({ password: _, ...rest }) => rest);
              }}
              error={errors.password}
              context={[values.username, values.email, values.first_name, values.last_name]}
            />
            <Checkbox
              label="Send the new user an email about their account"
              description="It includes their username and a link to set their own password."
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
          </div>
        </Card>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={busy}>
            {busy ? 'Adding…' : 'Add user'}
          </Button>
        </div>
      </form>
    </>
  );
}
