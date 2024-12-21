# Redash research
## tl;dr
Found a primitive without being enable to exploit to a real vulnerability.<br>
However, I will write about the research itself

## The research
I went over the entire backend (I focused on a server side vulnerability, such as RCE, Auth bypass, Data modification and etc.)<br>

I was about to gave up when I saw the following function, and said to myself "This function is so fucked up, what are the chances someone used it insecurly?"<br>
```python
# TODO: this should probably be somewhere else
def update_model(self, model, updates):
    for k, v in updates.items():
        setattr(model, k, v)
```
Well, low. But not zero!<br>

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

It's based on the `Resource` class of flask-restful which is an extension for Flask that adds support for quickly building REST APIs.
<br>
We can see the route requires `edit_query` permission (primitive limitation).
We can see the route receives a json request (`request.get_json(force=True)`), removes two keys, and then calls the `update_model` function which will `setattr` all the other items left in in request body!<br>

### The model
Ok, so we can use `setattr` on every field we want. What can we achieve from that?

Let's see the model itself:
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
So we can't change `id` or `query_id` as they are the only keys which are sanitized, but we can change the others - but this is the feature... :(

### Out of the box(or class?)
Well, we don't have an identified behaviour chaning values we're permitted to changed. However, the `Vizulization` resource inherits from three other classes, which are also accessible! <br>

The relevant classes: `TimestampMixin`, `BelongsToOrgMixin`, `db.Model`
The first two are just mixins, which is a concept in SQLAlchamy for fields that're shared between models, such as creation and update date.

Therefore, our targeted class is `db.Model`, which is SQLAlchemy defined.<br>

What does it contain?
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

By reading the fields docstrings(and later verifying that), we can undertand our scope isn't relevant to them.

Using `dir()` on a `Visualization` object, we can see what are all the attributes we're accessible for:
```python
['__class__', '__delattr__', '__dict__', '__dir__', '__doc__', '__eq__', '__format__', '__ge__', '__getattr__', '__getattribute__', '__gt__', '__hash__', '__init__', '__init_subclass__', '__le__', '__lt__', '__mapper__', '__module__', '__ne__', '__new__', '__reduce__', '__reduce_ex__', '__repr__', '__setattr__', '__sizeof__', '__str__', '__subclasshook__', '__table__', '__tablename__', '__weakref__', '_decl_class_registry', '_sa_class_manager', '_sa_instance_state', 'copy', 'created_at', 'description', 'get_by_id_and_org', 'id', 'metadata', 'name', 'options', 'query', 'query_class', 'query_id', 'query_rel', 'type', 'updated_at']
```

Firstly I wanted to override `__dict__` so I will be able to modify also the "forbidden" fields (id, query_id).
However, by doing so I encountered with the following error:

`[2024-11-06 21:40:06,354][PID:9][ERROR][redash.app] Exception on /api/visualizations/1 [POST]`
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
`[2024-11-06 21:40:06,365][PID:9][INFO][metrics] method=POST path=/api/visualizations/1 endpoint=visualization status=500 content_type=application/json content_length=36 duration=17.08 query_count=6 query_duration=3.53`

What is this state that I overrode?
`_sa_instance_state` field! (you can also see that in the attribute list above)
Hmm. That's a problem since I need this field to have an attribute of `_modified_event` at least.<br>
In JS, we can access to attributes also using brackets, and also using dot. unfortunately, Python doesn't support that (and using inner dict won't solve this issue).

<br>
Later I tried overriding the other fields, but no suceess seen.
So, maybe are we able to *add* fields, so SQLAlchamy would parse them into extra actions?

### SQLAlchamy internals
#### What is SQLAlchamy?
"SQLAlchemy is an open-source Python library that provides an SQL toolkit (called "SQLAlchemy Core") and an Object Relational Mapper (ORM) for database interactions. It allows developers to work with databases using Python objects, enabling efficient and flexible database access."
[wikipedia](https://en.wikipedia.org/wiki/SQLAlchemy)

#### redash use
Redash uses SQLAlchamy for it's ORM functionallity. It has `Models`, which each represents a table in the DB, but also contains extra Python functions that're relevant to the table.
The SQL operations are performed internnaly in the SQLAlchamy, while redash performes Python specific actions (even using `select`)
<br>

Example:
```python
my_visualization = Visualization.query.filter(Visualization.id == object_id)
my_visualization.name = "HomiGrotas's visualization"
models.db.session.commit()
```
SQLAlchamy internally detects whether changes were made, and executes the change in the relevant dialect for the DB (SQlite, Postgres, MySQL and etc.).<br>
Therefore, adding another field won't help since SQLAlchamy checks only the relevant fields, looking at the class, and not at the instance.

#### Debugging SQLAlchamy
To debug, we would like to inspect the log mesasages, even the debug one:
```python
logger = logging.getLogger('sqlalchemy')
logger.setLevel(logging.DEBUG)
```

The logs which are logged to our console:
```
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

#### Adding fields to the model
One of the research methods was to add custom fields, which being translated to SQL, will affect SQLAlchamy, or even the SQL itself.
However, I discovered that adding an unknown field wouldn't trigger a change in the model (and a change in other field later won't "see" the changed value)

Why? This's caused due to the way SQLAlchamy way of detecting changes in the model.
It uses a class that wraps the atrributes usage:
```python
class InstrumentedAttribute(QueryableAttribute):
    """Class bound instrumented attribute which adds basic
    :term:`descriptor` methods.

    See :class:`.QueryableAttribute` for a description of most features.


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
Therefore, SQLAlchamy won't catch the change, and won't execute it.

#### overriding other fields
Since SQLAlchamy uses classes, and not raw data types, the attack surface shrinked.
Currently I didn't find a valuable field to override which will cause another behavior than an Exception.


## Summary
We found a very cool primitive, but couldn't exploit it due to SQLAlchamy way of handling changes in the instances.<br>
If you think you have another idea, you're welcome to get in touch using homigrotas2020@gmail.com
