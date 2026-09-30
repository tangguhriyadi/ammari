import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const sql = postgres(DATABASE_URL, { max: 1 });

const [row] = await sql<{ version: string }[]>`select version()`;
console.log(row?.version);

const extensions = await sql<{ name: string }[]>`
  select name from pg_available_extensions where name in ('citext', 'vector') order by name
`;

const available = new Set(extensions.map((extension) => extension.name));
for (const name of ["citext", "vector"]) {
  console.log(`${name}: ${available.has(name) ? "available" : "NOT available"}`);
}

await sql.end();
