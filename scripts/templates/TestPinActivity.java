package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

public class TestPinActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_TEST_PIN_MODE = "test_pin_mode";
    private static final String TEST_PIN = "999999";
    private static final String EXTRA_CALLBACK_ACTION = "callback_action";
    private static final String ACTION_GATE_SUCCESS = "test_pin_gate_success";
    private static final String ACTION_RELOCK_SUCCESS = "test_pin_relock_success";

    private EditText pinInput;
    private String callbackAction = "";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Check if test pin mode is enabled
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            Log.d("Facilitat.TestPin", "test pin mode not enabled");
            finish();
            return;
        }

        callbackAction = getIntent().getStringExtra(EXTRA_CALLBACK_ACTION);
        if (callbackAction == null) {
            callbackAction = ACTION_GATE_SUCCESS;
        }

        setContentView(buildPinLayout());
        Log.d("Facilitat.TestPin", "created (callback=" + callbackAction + ")");
    }

    private View buildPinLayout() {
        // Simple vertical layout with PIN input and number buttons
        android.widget.LinearLayout rootLayout = new android.widget.LinearLayout(this);
        rootLayout.setOrientation(android.widget.LinearLayout.VERTICAL);
        rootLayout.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT
        ));
        rootLayout.setPadding(20, 40, 20, 40);

        // Title
        android.widget.TextView titleView = new android.widget.TextView(this);
        titleView.setText("Mode Test PIN (Dev Only)");
        titleView.setTextSize(18);
        titleView.setTextColor(0xFF333333);
        android.widget.LinearLayout.LayoutParams titleParams = new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        );
        titleParams.bottomMargin = 20;
        rootLayout.addView(titleView, titleParams);

        // PIN input field
        pinInput = new EditText(this);
        pinInput.setHint("Entrez le code PIN");
        pinInput.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pinInput.setTextSize(16);
        android.widget.LinearLayout.LayoutParams pinParams = new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        );
        pinParams.bottomMargin = 20;
        rootLayout.addView(pinInput, pinParams);

        // Number pad
        android.widget.GridLayout gridLayout = new android.widget.GridLayout(this);
        gridLayout.setColumnCount(3);
        android.widget.LinearLayout.LayoutParams gridParams = new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        );
        gridParams.bottomMargin = 20;

        for (int i = 1; i <= 9; i++) {
            addNumberButton(gridLayout, String.valueOf(i));
        }
        addNumberButton(gridLayout, "0");

        rootLayout.addView(gridLayout, gridParams);

        // Buttons
        android.widget.LinearLayout buttonLayout = new android.widget.LinearLayout(this);
        buttonLayout.setOrientation(android.widget.LinearLayout.HORIZONTAL);
        buttonLayout.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        Button clearBtn = new Button(this);
        clearBtn.setText("Effacer");
        clearBtn.setOnClickListener(v -> pinInput.setText(""));
        android.widget.LinearLayout.LayoutParams clearParams = new android.widget.LinearLayout.LayoutParams(
                0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                1.0f
        );
        clearParams.rightMargin = 10;
        buttonLayout.addView(clearBtn, clearParams);

        Button submitBtn = new Button(this);
        submitBtn.setText("Valider");
        submitBtn.setOnClickListener(v -> validatePin());
        android.widget.LinearLayout.LayoutParams submitParams = new android.widget.LinearLayout.LayoutParams(
                0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                1.0f
        );
        buttonLayout.addView(submitBtn, submitParams);

        rootLayout.addView(buttonLayout);

        return rootLayout;
    }

    private void addNumberButton(android.widget.GridLayout parent, String number) {
        Button btn = new Button(this);
        btn.setText(number);
        btn.setOnClickListener(v -> {
            pinInput.append(number);
        });
        android.widget.GridLayout.LayoutParams params = new android.widget.GridLayout.LayoutParams();
        params.width = 0;
        params.height = android.widget.GridLayout.LayoutParams.WRAP_CONTENT;
        params.columnSpec = android.widget.GridLayout.spec(
                android.widget.GridLayout.UNDEFINED,
                1.0f
        );
        params.bottomMargin = 5;
        params.rightMargin = 5;
        parent.addView(btn, params);
    }

    private void validatePin() {
        String entered = pinInput.getText().toString();
        if (TEST_PIN.equals(entered)) {
            Log.d("Facilitat.TestPin", "PIN correct -> callback=" + callbackAction);
            // Invoke callback to simulate successful authentication
            invokeCallback();
        } else {
            Toast.makeText(this, "Code PIN incorrect", Toast.LENGTH_SHORT).show();
            pinInput.setText("");
        }
    }

    private void invokeCallback() {
        Intent resultIntent = new Intent();
        resultIntent.setAction(callbackAction);
        resultIntent.putExtra("test_pin_accepted", true);
        setResult(Activity.RESULT_OK, resultIntent);

        // If this is a startActivityForResult, finish and let the caller handle it
        if (getCallingActivity() != null) {
            finish();
            return;
        }

        // Otherwise, broadcast or finish
        finish();
    }
}
