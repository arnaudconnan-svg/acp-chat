package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public class CountryPickerActivity extends Activity {

    private static class Country implements Comparable<Country> {
        final String code;
        final String name;

        Country(String code, String name) {
            this.code = code;
            this.name = name;
        }

        @Override
        public int compareTo(Country o) {
            return name.compareTo(o.name);
        }

        @Override
        public String toString() {
            return name + "  \u00b7  " + code;
        }
    }

    private final List<Country> allCountries = new ArrayList<>();
    private final List<Country> filtered = new ArrayList<>();
    private ArrayAdapter<Country> adapter;
    private String callbackPath = "/account.html";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("Choisir un pays");

        String currentCode = null;
        Uri data = getIntent().getData();
        if (data != null) {
            currentCode = data.getQueryParameter("current");
            String cb = data.getQueryParameter("callback_path");
            if ("/auth.html".equals(cb) || "/account.html".equals(cb)) {
                callbackPath = cb;
            }
        }

        buildCountryList();
        filtered.addAll(allCountries);

        final int pad = dp(16);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);

        EditText search = new EditText(this);
        search.setHint("Rechercher\u2026");
        search.setSingleLine(true);
        search.setTextColor(0xFF1F1F1F);
        search.setHintTextColor(0xFF7A7A7A);
        search.setBackgroundColor(0xFFF5F5F5);
        search.setPadding(pad, pad, pad, pad);
        root.addView(search, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        final ListView list = new ListView(this);
        list.setDividerHeight(1);
        root.addView(list, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        adapter = new ArrayAdapter<Country>(this, android.R.layout.simple_list_item_1, filtered) {
            @Override
            public android.view.View getView(int position, android.view.View convertView, ViewGroup parent) {
                android.view.View view = super.getView(position, convertView, parent);
                TextView text = view.findViewById(android.R.id.text1);
                if (text != null) {
                    text.setTextColor(0xFF1F1F1F);
                    text.setBackgroundColor(0xFFFFFFFF);
                    text.setTextSize(17f);
                    text.setPadding(dp(16), dp(14), dp(16), dp(14));
                }
                return view;
            }
        };
        list.setAdapter(adapter);

        scrollToCode(list, currentCode);

        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
            @Override
            public void afterTextChanged(Editable s) {
                String q = s.toString().toLowerCase(Locale.FRENCH).trim();
                filtered.clear();
                for (Country c : allCountries) {
                    if (q.isEmpty()
                            || c.name.toLowerCase(Locale.FRENCH).contains(q)
                            || c.code.toLowerCase(Locale.US).startsWith(q)) {
                        filtered.add(c);
                    }
                }
                adapter.notifyDataSetChanged();
            }
        });

        list.setOnItemClickListener((parent, view, pos, id) ->
                returnCountry(filtered.get(pos).code));

        setContentView(root);
    }

    private void returnCountry(String code) {
        String base = "https://acp-chat-beta.onrender.com" + callbackPath;
        Uri uri = Uri.parse(base).buildUpon()
                .appendQueryParameter("_android_country_selected", code)
                .build();
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.setClass(this, LauncherActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    private void buildCountryList() {
        for (String code : Locale.getISOCountries()) {
            Locale locale = new Locale("fr", code);
            String name = locale.getDisplayCountry(Locale.FRENCH);
            if (name != null && !name.isEmpty() && !name.equals(code)) {
                allCountries.add(new Country(code.toUpperCase(Locale.US), name));
            }
        }
        Collections.sort(allCountries);
    }

    private void scrollToCode(ListView list, String code) {
        if (code == null || code.isEmpty()) return;
        for (int i = 0; i < filtered.size(); i++) {
            if (filtered.get(i).code.equalsIgnoreCase(code)) {
                list.setSelection(i);
                return;
            }
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
