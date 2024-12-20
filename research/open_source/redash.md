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
