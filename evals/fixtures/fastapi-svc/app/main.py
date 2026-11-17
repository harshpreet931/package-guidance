from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="inventory")
ITEMS: dict[int, dict] = {}


class Item(BaseModel):
    name: str
    quantity: int = 0


@app.get("/items")
def list_items():
    return list(ITEMS.values())


@app.post("/items", status_code=201)
def create_item(item: Item):
    item_id = len(ITEMS) + 1
    ITEMS[item_id] = {"id": item_id, **item.model_dump()}
    return ITEMS[item_id]
