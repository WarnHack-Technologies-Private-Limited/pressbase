/**
 * Post statuses — WordPress's register_post_status() and the core statuses
 * from create_initial_post_types() (wordpress/wp-includes/post.php).
 */

export interface PostStatus {
  name: string;
  label: string;
  /** Visible to everyone (publish). */
  public: boolean;
  /** Visible only to people who can read private posts (private). */
  private: boolean;
  /** Visible only to people who can edit (draft, pending, future). */
  protected: boolean;
  /** Counted in the admin's "All" list. */
  showInAdminAllList: boolean;
  /** Has its own tab in admin lists. */
  showInAdminStatusList: boolean;
  internal: boolean;
}

const CORE: PostStatus[] = [
  {
    name: 'publish',
    label: 'Published',
    public: true,
    private: false,
    protected: false,
    showInAdminAllList: true,
    showInAdminStatusList: true,
    internal: false,
  },
  {
    name: 'future',
    label: 'Scheduled',
    public: false,
    private: false,
    protected: true,
    showInAdminAllList: true,
    showInAdminStatusList: true,
    internal: false,
  },
  {
    name: 'draft',
    label: 'Draft',
    public: false,
    private: false,
    protected: true,
    showInAdminAllList: true,
    showInAdminStatusList: true,
    internal: false,
  },
  {
    name: 'pending',
    label: 'Pending',
    public: false,
    private: false,
    protected: true,
    showInAdminAllList: true,
    showInAdminStatusList: true,
    internal: false,
  },
  {
    name: 'private',
    label: 'Private',
    public: false,
    private: true,
    protected: false,
    showInAdminAllList: true,
    showInAdminStatusList: true,
    internal: false,
  },
  {
    name: 'trash',
    label: 'Trash',
    public: false,
    private: false,
    protected: false,
    showInAdminAllList: false,
    showInAdminStatusList: true,
    internal: true,
  },
  {
    name: 'auto-draft',
    label: 'Auto Draft',
    public: false,
    private: false,
    protected: false,
    showInAdminAllList: false,
    showInAdminStatusList: false,
    internal: true,
  },
  {
    name: 'inherit',
    label: 'Inherit',
    public: false,
    private: false,
    protected: false,
    showInAdminAllList: false,
    showInAdminStatusList: false,
    internal: true,
  },
];

export class PostStatusRegistry {
  #statuses = new Map(CORE.map((s) => [s.name, s]));

  register(status: PostStatus): void {
    this.#statuses.set(status.name, status);
  }

  get(name: string): PostStatus | undefined {
    return this.#statuses.get(name);
  }

  all(): PostStatus[] {
    return [...this.#statuses.values()];
  }
}
