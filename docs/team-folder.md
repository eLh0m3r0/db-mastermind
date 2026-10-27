# Team folder

Share connections, saved queries and knowledge bases with your team through any shared folder: a network drive,
OneDrive/SharePoint, Dropbox or a Git repository everyone pulls.

Set it in **Settings → General → Team folder**. An IT department can set it for everyone with `"teamFolder"` in
the [managed configuration](managed-config.md).

## OneDrive, SharePoint and Teams channels

DB Mastermind works with any folder on disk, so a Teams channel's files work once OneDrive syncs them to your
computer:

1. In Teams, open the channel → **Files** → **Open in SharePoint** (or the **…** menu in the Files tab).
2. Click **Sync** (the whole library) or **Add shortcut to My files** (just that folder).
3. The folder appears in File Explorer under your company's name, e.g. `C:\Users\jan\Contoso\Sales - Data`, or in
   `OneDrive - Contoso` for a shortcut. On a Mac it's in Finder under *OneDrive* (`~/Library/CloudStorage/…`).
4. Right-click the folder → **Always keep on this device**, so notes are there offline and colleagues' changes show
   up right away.
5. Pick that folder as the **team folder** (Settings → General) or as one connection's knowledge base
   (Knowledge base → **Change…**).

If two people edit the same note at the same moment, OneDrive keeps both and adds the computer's name to one of
them (e.g. `orders-LAPTOP-JAN.md`); merge them by hand. Passwords never go to the folder.

## Layout

```
team-folder/
  connections.json              connections without passwords
  queries/
    Reports/Top customers.sql   saved queries, shown under "Team/Reports"
    ping.sql                    shown under "Team"
  diagrams/
    Sales.json                  saved ER diagrams (tables, layout, colors, notes)
  knowledge/
    team-erp/                   knowledge base (Markdown notes) of the connection with id "team-erp"
```

- **connections.json** uses the same format as *Share with colleagues*. You can also right-click a connection and
  choose **Add to team folder**.
  - Connections without an `id` get one from their name, e.g. "ERP" becomes `team-erp`.
  - Passwords are never written. Everyone enters their own, stored encrypted on their computer.
  - Team connections show a people icon. To delete one, first remove it from the team folder; it then stays on
    your computer as a personal connection.
- **queries/** holds plain `.sql` files. To share a query, save it into a folder named `Team` or `Team/…`.
  Optional header lines pick the connection and add a description:
  ```sql
  -- connection: ERP
  -- description: Customers by revenue this year
  SELECT …
  ```
- **knowledge/** holds a folder per connection, named by its id or name. It's used as that connection's knowledge
  base automatically. You can also set `knowledgeBasePath` in connections.json, relative to the team folder.
  *Add to team folder* copies the connection's knowledge base there (into `knowledge/<id>`) and switches it to the
  team copy, so colleagues get the same notes and team AI tools.

- **diagrams/**: in the ER diagram, choose **Diagrams → Share with the team folder**. Team diagrams appear in the
  same menu, marked *Team*. Moving tables or notes there updates the shared file.

Changes made by colleagues show up within a second while the app is running.
