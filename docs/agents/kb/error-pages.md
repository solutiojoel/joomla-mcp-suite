# KB — Error Pages (404)

How to set up and customize the 404 error page on a Solutio site.

---

## Standard Error Page Content

The default 404 message used across Solutio sites:

```html
<h4 style="text-align: center;">
  St. Anthony, please come around. <br />This page is lost and cannot be found.
</h4>
<p>
  <img style="display: block; margin-left: auto; margin-right: auto;"
       src="https://solutio-sop.solutiosoftware.com/images/stories/prayinghands-black.png" />
</p>
<p style="text-align: center;">
  Please head back to the <a href="/home">homepage</a> and try again.
</p>
```

---

## Gantry 5 Error Outline Setup

This is typically handled automatically by the template import. If not:

1. Navigate to the **Error Outline** layout in Gantry 5.
2. Move the **Simple Content** particle to the Main container.
3. Use the `+` button to add a second row in the container.
4. For the top three and bottom three containers of the outline, set **inheritance** to either:
   - The **Base Outline**, or
   - The **Parish Subpages** outline (which itself inherits top from Parish Home)
5. Edit the Simple Content particle — update the title with the 404 message content above.
