---
layout: post
title: "Redash — Mass Assignment in the Visualization API"
date: 2024-12-21
category: open source
tags: [mass-assignment, sqlalchemy, python, open-source, websec]
severity: low
excerpt: "A deep dive into Redash's Visualization API: a mass-assignment primitive on SQLAlchemy models that could set any attribute — and why SQLAlchemy's internals turned a promising bug into a dead end."
---

# Redash — Mass Assignment in the Visualization API

## tl;dr

I found a **mass-assignment primitive** in Redash's `Visualization` resource: an authenticated user with `edit_query` permission can `setattr()` **any** attribute on the model instance. The endpoint only sanitizes two keys. However — after a deep dive into SQLAlchemy's internals — I was unable to escalate the primitive into a real vulnerability (RCE, auth bypass, or data modification outside the intended feature). This writeup documents both the finding and the dead ends, in case anyone wants to take the primitive further.

## The research

I reviewed the entire Redash backend looking for a server-side vulnerability class: RCE, authentication bypass, privilege escalation, or data modification. I was about to give up when I hit this function — one of those "surely someone used this insecurely" moments:

```python
# TODO: this should probably be somewhere else
def update_model(self, model, updates):
    for k, v in updates.items():
        setattr(model, k, v)
```

An unvalidated `setattr()` over user-controlled keys. The question became: **what can you reach with an arbitrary `setattr` on a Redash model?**

### The route

Meet the `Visualization` resource:

```python
class VisualizationResource(BaseResource):
    @require_permission("edit_query")
    def post(self, visualization_id):
        vis = get_object_or_404(models.Visualization.get_by_id_and_org, visualization_id, self.current_org)
        require_object_modify_permission(vis.query_rel, self.current_user)

        kwargs = request.get_json(force=True)

        kwargs.pop("id", None)
        kwargs.pop("query_id", None)

        self.update_model(vis, kwargs)
        d = serialize_visualization(vis, with_query=False)
        models.db.session.commit()
        return d
```

Notes on the route:

- It's built on flask-restful's `Resource`, an extension that adds rapid REST API construction to Flask.
- `@require_permission("edit_query")` gates the endpoint — a real (if modest) **privilege requirement**: the attacker needs to be able to edit queries in the first place.
- `request.get_json(force=True)` parses the body, **two keys are removed** (`id`, `query_id`), and everything else flows straight into `update_model` → `setattr`.

So: `setattr` on every field we want, as long as the user already holds `edit_query`.

### The model

What attributes can we actually reach? The model itself:

```python
@generic_repr("id", "name", "type", "query_id")
class Visualization(TimestampMixin, BelongsToOrgMixin, db.Model):
    id = primary_key("Visualization")
    type = Column(db.String(100))
    query_id = Column(key_type("Query"), db.ForeignKey("queries.id"))
    # query_rel and not query, because db.Model already has query defined.
    query_rel = db.relationship(Query, back_populates="visualizations")
    name = Column(db.String(255))
    description = Column(db.String(4096), nullable=True)
    options = Column(MutableDict.as_mutable(JSONB), nullable=True)

    __tablename__ = "visualizations"

    def __str__(self):
        return "%s %s" % (self.id, self.type)

    @classmethod
    def get_by_id_and_org(cls, object_id, org):
        return super(Visualization, cls).get_by_id_and_org(object_id, org, Query)

    def copy(self):
        return {
            "type": self.type,
            "name": self.name,
            "description": self.description,
            "options": self.options,
        }
```

`id` and `query_id` are stripped — so the two keys that would let us repoint the row are off-limits. The rest (`name`, `description`, `type`, `options`) are exactly the fields the feature is *supposed* to edit. On the surface: a mass-assignment with nothing interesting to assign.

But wait — the class inherits from more than its own columns.

### Out of the box (or: out of the class?)

`Visualization` inherits from three parent classes:

1. **`TimestampMixin`** — `created_at`, `updated_at`
2. **`BelongsToOrgMixin`** — org scoping fields
3. **`db.Model`** — SQLAlchemy's base class

The two mixins are just shared column holders. The interesting target is `db.Model` — the SQLAlchemy-defined base. What does it contain?

```python
class Model(object):
    """Base class for SQLAlchemy declarative base model.

    To define models, subclass :attr:`db.Model <SQLAlchemy.Model>`, not this
    class. To customize ``db.Model``, subclass this and pass it as
    ``model_class`` to :class:`SQLAlchemy`.
    """

    #: Query class used by :attr:`query`. Defaults to
    # :class:`SQLAlchemy.Query`, which defaults to :class:`BaseQuery`.
    query_class = None

    #: Convenience property to query the database for instances of this model
    # using the current session. Equivalent to ``db.session.query(Model)``
    # unless :attr:`query_class` has been changed.
    query = None

    def __repr__(self):
        identity = inspect(self).identity
        if identity is None:
            pk = "(transient {0})".format(id(self))
        else:
            pk = ', '.join(to_str(value) for value in identity)
        return '<{0} {1}>'.format(type(self).__name__, pk)
```

Reading the docstrings (and later verifying), the two class-level attributes are not usefully overridable from a request body.

Using `dir()` on a `Visualization` instance shows the full attribute surface we could try to clobber:

```python
['__class__', '__delattr__', '__dict__', '__dir__', '__doc__', '__eq__', '__format__', '__ge__',
 '__getattr__', '__getattribute__', '__gt__', '__hash__', '__init__', '__init_subclass__', '__le__',
 '__lt__', '__mapper__', '__module__', '__ne__', '__new__', '__reduce__', '__reduce_ex__', '__repr__',
 '__setattr__', '__sizeof__', '__str__', '__subclasshook__', '__table__', '__tablename__', '__weakref__',
 '_decl_class_registry', '_sa_class_manager', '_sa_instance_state', 'copy', 'created_at', 'description',
 'get_by_id_and_org', 'id', 'metadata', 'name', 'options', 'query', 'query_class', 'query_id',
 'query_rel', 'type', 'updated_at']
```

### Dead end #1 — overriding `__dict__`

My first idea: override `__dict__` to inject values into the "forbidden" fields (`id`, `query_id`). It broke immediately:

```text
[2024-11-06 21:40:06,354][PID:9][ERROR][redash.app] Exception on /api/visualizations/1 [POST]
```

```python
Traceback (most recent call last):
  File "/usr/local/lib/python3.7/site-packages/flask/app.py", line 1949, in full_dispatch_request
    rv = self.dispatch_request()
  File "/usr/local/lib/python3.7/site-packages/flask/app.py", line 1935, in dispatch_request
    return self.view_functions[rule.endpoint](**req.view_args)
  File "/usr/local/lib/python3.7/site-packages/flask_restful/__init__.py", line 458, in wrapper
    resp = resource(*args, **kwargs)
  File "/usr/local/lib/python3.7/site-packages/flask_login/utils.py", line 261, in decorated_view
    return func(*args, **kwargs)
  File "/usr/local/lib/python3.7/site-packages/flask/views.py", line 89, in view
    return self.dispatch_request(*args, **kwargs)
  File "/app/redash/handlers/base.py", line 33, in dispatch_request
    return super(BaseResource, self).dispatch_request(*args, **kwargs)
  File "/usr/local/lib/python3.7/site-packages/flask_restful/__init__.py", line 573, in dispatch_request
    resp = meth(*args, **kwargs)
  File "/app/redash/permissions.py", line 71, in decorated
    return fn(*args, **kwargs)
  File "/app/redash/handlers/visualizations.py", line 44, in post
    self.update_model(vis, kwargs)
  File "/app/redash/handlers/base.py", line 49, in update_model
    setattr(model, k, v)
  File "/usr/local/lib/python3.7/site-packages/sqlalchemy/orm/attributes.py", line 268, in __set__
    instance_state(instance), instance_dict(instance), value, None
  File "/usr/local/lib/python3.7/site-packages/sqlalchemy/orm/attributes.py", line 852, in set
    state._modified_event(dict_, self, old)
AttributeError: 'None' object has no attribute '_modified_event'
```

Which state did I just destroy? The **`_sa_instance_state`** field — you can see it in the `dir()` output above. It's SQLAlchemy's per-instance bookkeeping object, and the error tells us exactly why this is fatal: SQLAlchemy needs it to have at least a `_modified_event` attribute for its change-tracking. In JS you can reach attributes with brackets *or* dot-notation; Python offers no such aliasing, so injecting through an inner dict doesn't help either.

### Dead end #2 — overriding the remaining fields

I tried clobbering the other instance attributes one by one. Nothing produced a behavior change — only exceptions.

### Dead end #3 — *adding* attributes

If overriding didn't work, maybe *adding* new fields could smuggle extra SQL? Understanding why that fails requires a look inside SQLAlchemy.

## SQLAlchemy internals

### What is SQLAlchemy?

> "SQLAlchemy is an open-source Python library that provides an SQL toolkit (called "SQLAlchemy Core") and an Object Relational Mapper (ORM) for database interactions. It allows developers to work with databases using Python objects, enabling efficient and flexible database access."
> — [Wikipedia](https://en.wikipedia.org/wiki/SQLAlchemy)

### How Redash uses it

Redash uses SQLAlchemy for its ORM. Each **Model** maps to a database table but also carries application logic. The SQL operations are executed internally by SQLAlchemy; Redash works with Python objects, even using `select`:

```python
my_visualization = Visualization.query.filter(Visualization.id == object_id)
my_visualization.name = "HomiGrotas's visualization"
models.db.session.commit()
```

SQLAlchemy detects changes and emits the right DML for the active dialect (SQLite, PostgreSQL, MySQL, …). The key property: **SQLAlchemy tracks changes through column descriptors defined on the class — not through whatever attributes happen to exist on an instance.** Adding a brand-new attribute to an instance therefore can't influence the generated SQL.

### Debugging SQLAlchemy

To watch this in action, enable the engine logger:

```python
logger = logging.getLogger('sqlalchemy')
logger.setLevel(logging.DEBUG)
```

```text
INFO:sqlalchemy.engine.base.Engine:()
DEBUG:sqlalchemy.engine.base.Engine:Col ('cid', 'name', 'type', 'notnull', 'dflt_value', 'pk')
DEBUG:sqlalchemy.engine.base.Engine:Row (0, 'updated_at', 'DATETIME', 1, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (1, 'created_at', 'DATETIME', 1, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (2, 'id', 'INTEGER', 1, None, 1)
DEBUG:sqlalchemy.engine.base.Engine:Row (3, 'type', 'VARCHAR(100)', 1, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (4, 'query_id', 'INTEGER', 1, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (5, 'name', 'VARCHAR(255)', 1, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (6, 'description', 'VARCHAR(4096)', 0, None, 0)
DEBUG:sqlalchemy.engine.base.Engine:Row (7, 'options', 'VARCHAR(4096)', 0, None, 0)
DEBUG:sqlalchemy.pool.impl.NullPool:Connection <sqlite3.Connection object at 0x718ac8445740> being returned to pool
DEBUG:sqlalchemy.pool.impl.NullPool:Connection <sqlite3.Connection object at 0x718ac8445740> rollback-on-return
DEBUG:sqlalchemy.pool.impl.NullPool:Closing connection <sqlite3.Connection object at 0x718ac8445740>
```

The schema reflection confirms it: only the seven columns we already knew about are ever touched by the ORM. Adding an eighth attribute to the instance changes nothing in the SQL.

### Why adding fields can't work

The change-detection is performed by **`InstrumentedAttribute`** — a descriptor that wraps attribute access:

```python
class InstrumentedAttribute(QueryableAttribute):
    """Class bound instrumented attribute which adds basic
    :term:`descriptor` methods.
    """

    def __set__(self, instance, value):
        self.impl.set(
            instance_state(instance), instance_dict(instance), value, None
        )

    def __delete__(self, instance):
        self.impl.delete(instance_state(instance), instance_dict(instance))

    def __get__(self, instance, owner):
        if instance is None:
            return self

        dict_ = instance_dict(instance)
        if self._supports_population and self.key in dict_:
            return dict_[self.key]
        else:
            return self.impl.get(instance_state(instance), dict_)
```

`__set__` routes every assignment through `instance_state(instance)` — the `_sa_instance_state` we already broke. A raw `setattr` of a non-column attribute bypasses this descriptor entirely, so SQLAlchemy never sees it. No change → no SQL → dead end.

### Summary of the escalation attempts

| Approach | Result |
|----------|--------|
| Override `__dict__` to reach `id`/`query_id` | Crashes change-tracking (`_sa_instance_state`) |
| Override other instance attributes | Exceptions only, no behavior change |
| Add new attributes | Ignored by ORM (class-level descriptors only) |

## Conclusion

The `Visualization` endpoint offers a genuine **mass-assignment primitive** — arbitrary `setattr` over model attributes for any user who can edit a query. But SQLAlchemy's architecture (class-bound descriptors + stateful change-tracking) caps what that primitive can do: the interesting attributes either crash the session or aren't part of the persistence model.

So we end with a very cool primitive and, currently, no weaponized exploit. If you see a path I missed, I'd genuinely like to hear it — you can reach me at **homigrotas2020@gmail.com**.

## Responsible disclosure

Reported to the Redash maintainers with the full analysis above. Worth noting this was investigated on a self-hosted instance during a security review; no production Redash deployment was affected.
